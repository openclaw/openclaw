import * as crypto from "node:crypto";
import {
  isJsonObject,
  type CodexTurn,
  type CodexTurnEnvironmentParams,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { hashCodexAppServerBindingFingerprint } from "./session-binding.js";
import { resolveCodexGpt56MultiAgentVersion } from "./thread-binding-policy.js";

/** Opaque identity for one native catalog-backed execution attempt. */
export function fingerprintCodexModelCatalogAttemptAuthority(params: {
  clientInstanceId: string;
  modelCatalogRevision: number;
}): string {
  return hashCodexAppServerBindingFingerprint(
    fingerprintJsonObject({
      clientInstanceId: params.clientInstanceId,
      modelCatalogRevision: params.modelCatalogRevision,
    }),
  );
}

export function codexDynamicToolsFingerprint(dynamicTools: readonly JsonValue[]): string {
  return hashCodexAppServerBindingFingerprint(codexLegacyDynamicToolsFingerprint(dynamicTools));
}

export function areCodexDynamicToolFingerprintsCompatible(params: {
  previous?: string;
  next: string;
  nextLegacy?: string;
}): boolean {
  return (
    !params.previous || params.previous === params.next || params.previous === params.nextLegacy
  );
}

export function codexLegacyDynamicToolsFingerprint(dynamicTools: readonly JsonValue[]): string {
  // Codex persists the complete model-visible schema at thread/start; resume
  // cannot refresh changed tool or nested input descriptions.
  return JSON.stringify(dynamicTools.map(stabilizeJsonValue).toSorted(compareJsonFingerprint));
}

export function legacyFingerprintUserMcpServersConfigPatch(
  configPatch: JsonObject | undefined,
): string | undefined {
  return configPatch ? JSON.stringify(stabilizeJsonValue(configPatch)) : undefined;
}

export function fingerprintUserMcpServersConfigPatch(
  configPatch: JsonObject | undefined,
): string | undefined {
  return configPatch
    ? hashCodexAppServerBindingFingerprint(
        JSON.stringify(stabilizeFingerprintValue(configPatch, true)),
      )
    : undefined;
}

function fingerprintUserMcpServersAuthorizationHeader(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? `<redacted:sha256:${crypto.createHash("sha256").update(value).digest("hex")}>`
    : "<redacted>";
}

export function fingerprintJsonObject(value: JsonObject): string {
  return JSON.stringify(stabilizeJsonValue(value));
}

/** Hash thread-creation identity; settings already applied by turn/start must not restart Codex. */
export function fingerprintCodexThreadConfig(
  initialRequest: JsonObject,
  authProfileId?: string,
  dynamicToolsFingerprint?: string,
  selection?: {
    model?: string | null;
    modelProvider?: string | null;
    preserveNativeModel?: boolean;
  },
): string {
  let { model, requestedModel, modelProvider, requestedModelProvider } = initialRequest;
  if (selection) {
    const preserve = selection.preserveNativeModel;
    requestedModel = preserve ? null : (model ?? null);
    model = preserve ? null : (selection.model ?? model ?? null);
    requestedModelProvider = preserve ? null : (modelProvider ?? selection.modelProvider ?? null);
    // A normalized native-auth provider is explicitly null; an absent warm
    // observation falls back to the requested provider.
    modelProvider = preserve
      ? null
      : selection.modelProvider === undefined
        ? (modelProvider ?? null)
        : selection.modelProvider;
  }
  return hashCodexAppServerBindingFingerprint(
    fingerprintJsonObject({
      authProfileId: authProfileId ?? null,
      dynamicToolsFingerprint: dynamicToolsFingerprint ?? null,
      // Codex fixes its model-selected native multi-agent generation for the
      // whole session; only same-generation model changes are turn-mutable.
      nativeMultiAgentVersion:
        resolveCodexGpt56MultiAgentVersion(
          typeof requestedModel === "string"
            ? requestedModel
            : typeof model === "string"
              ? model
              : undefined,
        ) ?? null,
      modelProvider: modelProvider ?? null,
      requestedModelProvider:
        requestedModelProvider === undefined ? (modelProvider ?? null) : requestedModelProvider,
      // Named permission profiles are not currently forwarded by turn/start,
      // so changing one still requires recreating the native thread.
      permissions: initialRequest.permissions ?? null,
      baseInstructions: initialRequest.baseInstructions ?? null,
      developerInstructions: initialRequest.developerInstructions ?? null,
      config: initialRequest.config ?? {},
    }),
  );
}

export function fingerprintEnvironmentSelection(
  environments: CodexTurnEnvironmentParams[] | undefined,
): string | undefined {
  return environments ? JSON.stringify(environments.map(stabilizeJsonValue)) : undefined;
}

export function stabilizeJsonValue(value: JsonValue): JsonValue {
  return stabilizeFingerprintValue(value, false);
}

function stabilizeFingerprintValue(value: JsonValue, redactMcpHeaders: boolean): JsonValue {
  if (Array.isArray(value)) {
    return value.map((child) => stabilizeFingerprintValue(child, redactMcpHeaders));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  // Indexed assignment would lose literal __proto__ schema, server, and policy keys.
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => {
        if (redactMcpHeaders && key === "http_headers" && isJsonObject(child)) {
          const headers = Object.fromEntries(
            Object.entries(child).map(([header, headerValue]) => [
              header,
              header.toLowerCase() === "authorization"
                ? fingerprintUserMcpServersAuthorizationHeader(headerValue)
                : headerValue,
            ]),
          );
          // Header values are opaque to redaction; only canonicalize their contents.
          return [key, stabilizeFingerprintValue(headers, false)];
        }
        return [key, stabilizeFingerprintValue(child, redactMcpHeaders)];
      }),
  );
}

export function readActiveCodexTurnIdsFromResume(response: {
  thread: { turns?: Pick<CodexTurn, "id" | "status">[] };
  initialTurnsPage?: { data?: Pick<CodexTurn, "id" | "status">[] } | null;
}): string[] {
  return (response.initialTurnsPage?.data ?? response.thread.turns ?? [])
    .filter((turn) => turn.status === "inProgress" && turn.id.trim().length > 0)
    .map((turn) => turn.id);
}

const LEGACY_EMPTY_DYNAMIC_TOOLS_FINGERPRINT = codexLegacyDynamicToolsFingerprint([]);
const EMPTY_DYNAMIC_TOOLS_FINGERPRINT = hashCodexAppServerBindingFingerprint(
  LEGACY_EMPTY_DYNAMIC_TOOLS_FINGERPRINT,
);

export function areUserMcpServersFingerprintsCompatible(params: {
  previous?: string;
  next?: string;
  nextLegacy?: string;
}): boolean {
  // Beta 5 stored raw stabilized JSON, while doctor hashes those exact bytes.
  // A successful resume rewrites either legacy form to the current redacted hash.
  return (
    params.previous === params.next ||
    params.previous === params.nextLegacy ||
    (params.nextLegacy !== undefined &&
      params.previous === hashCodexAppServerBindingFingerprint(params.nextLegacy))
  );
}

export function shouldStartTransientNoToolThread(params: {
  previous: string | undefined;
  nextHasDynamicTools: boolean;
}): boolean {
  return Boolean(
    params.previous &&
    params.previous !== EMPTY_DYNAMIC_TOOLS_FINGERPRINT &&
    params.previous !== LEGACY_EMPTY_DYNAMIC_TOOLS_FINGERPRINT &&
    !params.nextHasDynamicTools,
  );
}

function compareJsonFingerprint(left: JsonValue, right: JsonValue): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
