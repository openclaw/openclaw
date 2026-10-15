import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeConfigOptionResult,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import {
  AcpRuntimeError,
  formatAcpErrorChain,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import type { CachedRuntimeState } from "./manager.runtime-handle-cache.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "./manager.types.js";
import { assertCurrentAcpActor, createUnsupportedControlError } from "./manager.utils.js";
import {
  buildRuntimeConfigOptionPairs,
  buildRuntimeControlSignature,
  isThinkingConfigKey,
  mergeRuntimeOptions,
  normalizeText,
  reconcileAcceptedRuntimeOptions,
  resolveRuntimeConfigOptionKey,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
} from "./runtime-options.js";

const OPTIONAL_TIMEOUT_CONFIG_KEYS = new Set(["timeout", "timeout_seconds"]);
const ACP_CONFIG_REJECTION_CODE_RE = /-3260[23]/;
const CONFIG_OPTION_REJECTION_RE =
  /invalid params|unsupported|not supported|not implement|invalid value|unknown config option|unknown value|not a valid value|must be one of/;

function extractConfigOptionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return normalizeText(entry);
      }
      const record = asNullableRecord(entry);
      return normalizeText(record?.id ?? record?.key);
    })
    .filter(Boolean) as string[];
}

function extractRuntimeStatusConfigOptionKeys(status: AcpRuntimeStatus | undefined): string[] {
  const details = asNullableRecord(status?.details);
  return [
    ...extractConfigOptionKeys(details?.configOptions),
    ...extractConfigOptionKeys(details?.config_options),
  ];
}

function isOptionalTimeoutConfigKey(key: string): boolean {
  return OPTIONAL_TIMEOUT_CONFIG_KEYS.has(normalizeLowercaseStringOrEmpty(key));
}

function isUnsupportedControlRejection(error: unknown): boolean {
  const errorCode = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
  return errorCode === "ACP_BACKEND_UNSUPPORTED_CONTROL";
}

function describeConfigOptionRejection(error: unknown): string {
  const described = toAcpRuntimeError({
    error,
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "",
  });
  return normalizeLowercaseStringOrEmpty(`${formatAcpErrorChain(error)} ${described.message}`);
}

function isUnsupportedOptionalTimeoutConfigRejection(key: string, error: unknown): boolean {
  if (!isOptionalTimeoutConfigKey(key)) {
    return false;
  }
  if (isUnsupportedControlRejection(error)) {
    return true;
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const normalized = normalizeLowercaseStringOrEmpty(message);
  return (
    normalized.includes("session/set_config_option") &&
    (normalized.includes("-32602") ||
      normalized.includes("invalid params") ||
      normalized.includes("unsupported") ||
      normalized.includes("not supported") ||
      normalized.includes("not implement"))
  );
}

function isRejectedThinkingConfigOption(key: string, error: unknown): boolean {
  if (!isThinkingConfigKey(key)) {
    return false;
  }
  if (isUnsupportedControlRejection(error)) {
    return true;
  }
  const description = describeConfigOptionRejection(error);
  const describesConfigOption =
    description.includes("session/set_config_option") ||
    (description.includes("config option") &&
      description.includes(normalizeLowercaseStringOrEmpty(key)));
  return (
    describesConfigOption &&
    ACP_CONFIG_REJECTION_CODE_RE.test(description) &&
    CONFIG_OPTION_REJECTION_RE.test(description)
  );
}

/**
 * Resolves backend-advertised controls plus locally inferred runtime control support.
 * Reported model/config controls are authoritative; setter presence only fills them in
 * for backends without capability discovery.
 */
export async function resolveManagerRuntimeCapabilities(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  includeStatusConfigOptionKeys?: boolean;
}): Promise<AcpRuntimeCapabilities> {
  let reported: AcpRuntimeCapabilities | undefined;
  if (params.runtime.getCapabilities) {
    reported = await withAcpRuntimeErrorBoundary({
      run: async () => await params.runtime.getCapabilities!({ handle: params.handle }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not read ACP runtime capabilities.",
    });
  }
  const controls = new Set<AcpRuntimeCapabilities["controls"][number]>(reported?.controls ?? []);
  if (params.runtime.setMode) {
    controls.add("session/set_mode");
  }
  if (!reported && params.runtime.setConfigOption) {
    controls.add("session/set_config_option");
  }
  if (!reported && params.runtime.setModel) {
    controls.add("session/set_model");
  }
  if (params.runtime.getStatus) {
    controls.add("session/status");
  }
  const normalizedKeys = new Set(
    (reported?.configOptionKeys ?? [])
      .map((entry) => normalizeText(entry))
      .filter(Boolean) as string[],
  );
  if (
    params.includeStatusConfigOptionKeys &&
    controls.has("session/set_config_option") &&
    params.runtime.getStatus
  ) {
    try {
      const status = await params.runtime.getStatus({ handle: params.handle });
      for (const key of extractRuntimeStatusConfigOptionKeys(status)) {
        normalizedKeys.add(key);
      }
    } catch (error) {
      if (isAcpOwnerRepairRequired(error)) {
        throw error;
      }
      // Status-derived option keys are an optional refinement. Keep the
      // capability result usable for runtimes that expose controls but cannot
      // answer status before a turn.
    }
  }
  return {
    controls: [...controls].toSorted(),
    ...(normalizedKeys.size > 0 ? { configOptionKeys: [...normalizedKeys] } : {}),
  };
}

type RuntimeModelResult = Exclude<Awaited<ReturnType<NonNullable<AcpRuntime["setModel"]>>>, void>;

/** Model after a write; `requested` means the backend reported no accepted model evidence. */
export type ManagerModelSelection =
  | { evidence: "accepted"; model: string | undefined }
  | { evidence: "requested"; model: string };

/** Backends may report the native id of the requested provider ref; keep the requested binding. */
function resolveAcknowledgedModel(requested: string, reported: string): string {
  return parseModelCatalogRef(requested)?.modelId === reported ? requested : reported;
}

function findModelOption(
  configOptions: AcpRuntimeConfigOptionResult["configOptions"] | undefined,
  key: string | undefined,
) {
  return (
    configOptions?.find((entry) => entry.id === key) ??
    configOptions?.find((entry) => entry.category === "model")
  );
}

function resolveModelSelection(
  result: RuntimeModelResult | void,
  key: string,
  requested: string,
): ManagerModelSelection {
  const configOptions = result?.configOptions;
  const option = findModelOption(configOptions, key);
  if (option) {
    return {
      evidence: "accepted",
      model:
        typeof option.currentValue === "string"
          ? resolveAcknowledgedModel(requested, option.currentValue)
          : undefined,
    };
  }
  if (typeof result?.currentModelId === "string") {
    return {
      evidence: "accepted",
      model: resolveAcknowledgedModel(requested, result.currentModelId),
    };
  }
  // A complete snapshot without a model option is authoritative.
  return configOptions
    ? { evidence: "accepted", model: undefined }
    : { evidence: "requested", model: requested };
}

/**
 * Reads model evidence from a snapshot returned by another control. A native id is qualified only
 * against the known binding; a snapshot without a model option leaves the binding unchanged.
 */
export function resolveSnapshotModelEvidence(
  result: AcpRuntimeConfigOptionResult | undefined,
  key: string | undefined,
  binding: string | undefined,
): ManagerModelSelection | undefined {
  const option = findModelOption(result?.configOptions, key);
  if (!option) {
    return undefined;
  }
  const reported = typeof option.currentValue === "string" ? option.currentValue : undefined;
  return {
    evidence: "accepted",
    model: reported && binding ? resolveAcknowledgedModel(binding, reported) : reported,
  };
}

/**
 * Persists accepted model evidence from a model write or another control's snapshot. Requested
 * selections stay desired/unverified; evidence without a model never clears the desired model.
 */
export function reconcileAcceptedModel(
  options: AcpSessionRuntimeOptions,
  selection: ManagerModelSelection | undefined,
): AcpSessionRuntimeOptions {
  if (selection?.evidence !== "accepted" || !selection.model) {
    return options;
  }
  return mergeRuntimeOptions({ current: options, patch: { model: selection.model } });
}

/**
 * Writes one config control for live-session replay and explicit commands. The protocol is
 * selected before writing: only model may use session/set_model, and a rejected write is never
 * retried through another protocol.
 */
export async function writeManagerConfigControl(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  capabilities: AcpRuntimeCapabilities;
  backend: string;
  key: string;
  value: string;
  isModel: boolean;
  assertBeforeWrite: () => void;
  assertAfterWrite: () => void;
}): Promise<{
  result: AcpRuntimeConfigOptionResult | undefined;
  model?: ManagerModelSelection;
}> {
  const { runtime, handle, capabilities, key, value } = params;
  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? [])
      .map((entry) => normalizeLowercaseStringOrEmpty(entry))
      .filter(Boolean),
  );
  const setConfigOption = capabilities.controls.includes("session/set_config_option")
    ? runtime.setConfigOption?.bind(runtime)
    : undefined;
  const setModel =
    params.isModel && capabilities.controls.includes("session/set_model")
      ? runtime.setModel?.bind(runtime)
      : undefined;
  let write: () => Promise<RuntimeModelResult | void>;
  if (
    setConfigOption &&
    (advertisedKeys.size === 0 || advertisedKeys.has(normalizeLowercaseStringOrEmpty(key)))
  ) {
    write = () => setConfigOption({ handle, key, value });
  } else if (setModel) {
    write = () => setModel({ handle, model: value });
  } else if (setConfigOption) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      `ACP backend "${params.backend}" does not accept config key "${key}".`,
    );
  } else {
    throw createUnsupportedControlError({
      backend: params.backend,
      control: params.isModel
        ? "session/set_config_option or session/set_model"
        : "session/set_config_option",
    });
  }
  params.assertBeforeWrite();
  const accepted = await write();
  params.assertAfterWrite();
  // Models-only evidence is not a config snapshot and must not clear selected thinking.
  const configOptions = accepted?.configOptions;
  return {
    result: configOptions ? { configOptions } : undefined,
    ...(params.isModel ? { model: resolveModelSelection(accepted, key, value) } : {}),
  };
}

/** Applies persisted runtime options to a live handle once per unique option signature. */
export async function applyManagerRuntimeControls(params: {
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  getCachedRuntimeState: (sessionKey: string) => CachedRuntimeState | null;
  isCurrentActor?: () => boolean;
  onOptionsChanged: (options: AcpSessionRuntimeOptions) => Promise<void>;
  onModelSelected?: (selection: ManagerModelSelection) => void;
}): Promise<void> {
  const isCurrentActor = params.isCurrentActor ?? (() => true);
  assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
  let options = resolveRuntimeOptionsFromMeta(params.meta);
  const thinkingExplicit = params.meta.thinkingExplicit;
  const signature = buildRuntimeControlSignature(options, thinkingExplicit);
  const cached = params.getCachedRuntimeState(params.sessionKey);
  if (cached?.appliedControlSignature === signature) {
    return;
  }

  const needsConfigOptionKeys = buildRuntimeConfigOptionPairs(options).length > 0;
  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime: params.runtime,
    handle: params.handle,
    includeStatusConfigOptionKeys: needsConfigOptionKeys,
  });
  assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
  const backend = params.handle.backend || params.meta.backend;
  const runtimeMode = options.runtimeMode;
  const configOptions = buildRuntimeConfigOptionPairs(options, capabilities.configOptionKeys);
  const thinkingConfigKey = options.thinking
    ? resolveRuntimeConfigOptionKey("thinking", capabilities.configOptionKeys)
    : undefined;
  const modelConfigKey = resolveRuntimeConfigOptionKey("model", capabilities.configOptionKeys);
  const assertActor = () => assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
  // Policy rebinds on a changed model or requested -> accepted, not on repeated accepted evidence.
  let boundModel = options.model;
  let reportedModel: ManagerModelSelection | undefined;
  const reportModel = (selection: ManagerModelSelection) => {
    if (
      selection.evidence === "accepted" &&
      reportedModel?.evidence === "accepted" &&
      reportedModel.model === selection.model
    ) {
      return;
    }
    reportedModel = selection;
    boundModel = selection.model;
    params.onModelSelected?.(selection);
  };

  await withAcpRuntimeErrorBoundary({
    run: async () => {
      assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
      if (runtimeMode) {
        if (!capabilities.controls.includes("session/set_mode") || !params.runtime.setMode) {
          throw createUnsupportedControlError({
            backend,
            control: "session/set_mode",
          });
        }
        await params.runtime.setMode({
          handle: params.handle,
          mode: runtimeMode,
        });
      }

      if (configOptions.length > 0) {
        for (const [key, requestedValue] of configOptions) {
          assertActor();
          // Model changes can clamp or remove unsupported thinking before its turn in the replay.
          const value = key === thinkingConfigKey ? options.thinking : requestedValue;
          if (value === undefined) {
            continue;
          }
          const isModel = key === modelConfigKey;
          try {
            const { result, model } = await writeManagerConfigControl({
              runtime: params.runtime,
              handle: params.handle,
              capabilities,
              backend,
              key,
              value,
              isModel,
              assertBeforeWrite: assertActor,
              assertAfterWrite: assertActor,
            });
            const selection =
              model ?? resolveSnapshotModelEvidence(result, modelConfigKey, boundModel);
            if (selection) {
              reportModel(selection);
            }
            const accepted = reconcileAcceptedRuntimeOptions(
              reconcileAcceptedModel(options, selection),
              result,
              isModel ? options.thinking : undefined,
            );
            if (!runtimeOptionsEqual(options, accepted)) {
              // Persist each accepted change even if a later control fails.
              await params.onOptionsChanged(accepted);
              assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
              options = accepted;
            }
          } catch (error) {
            assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
            if (isUnsupportedOptionalTimeoutConfigRejection(key, error)) {
              continue;
            }
            // Explicit thinking must fail before prompting; model and owner failures always propagate.
            if (
              key === thinkingConfigKey &&
              !isModel &&
              thinkingExplicit !== true &&
              !isAcpOwnerRepairRequired(error) &&
              isRejectedThinkingConfigOption(key, error)
            ) {
              logVerbose(
                `acp-manager: ${thinkingExplicit === false ? "inherited" : "legacy"} thinking "${value}" was not applied for ${params.sessionKey} (config key "${key}"): ${formatAcpErrorChain(error)}`,
              );
              continue;
            }
            throw error;
          }
        }
      }
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not apply ACP runtime options before turn execution.",
  });

  assertCurrentAcpActor(isCurrentActor(), params.sessionKey);
  if (cached) {
    cached.appliedControlSignature = buildRuntimeControlSignature(options, thinkingExplicit);
  }
}
