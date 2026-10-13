import { isAbsolute } from "node:path";
import type { AcpRuntimeConfigOptionResult } from "@openclaw/acp-core/runtime/types";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString as normalizeText,
} from "@openclaw/normalization-core/string-coerce";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
import { AcpRuntimeError } from "../runtime/errors.js";

export { normalizeOptionalString as normalizeText } from "@openclaw/normalization-core/string-coerce";

const MAX_RUNTIME_MODE_LENGTH = 64;
const MAX_MODEL_LENGTH = 200;
const MAX_THINKING_LENGTH = 32;
const MAX_PERMISSION_PROFILE_LENGTH = 80;
const MAX_CWD_LENGTH = 4096;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_BACKEND_OPTION_KEY_LENGTH = 64;
const MAX_BACKEND_OPTION_VALUE_LENGTH = 512;
const MAX_BACKEND_EXTRAS = 32;

const SAFE_OPTION_KEY_RE = /^[a-z0-9][a-z0-9._:-]*$/i;
// User-facing config aliases accepted by ACP clients and normalized to session runtime options.
const RUNTIME_CONFIG_OPTION_ALIASES = {
  model: ["model"],
  thinking: ["thinking", "effort", "reasoning_effort", "thought_level"],
  permissionProfile: ["approval_policy", "permission_profile", "permissions", "permission_mode"],
  timeoutSeconds: ["timeout", "timeout_seconds"],
} as const;

function failInvalidOption(message: string): never {
  throw new AcpRuntimeError("ACP_INVALID_RUNTIME_OPTION", message);
}

function validateBoundedText(value: unknown, field: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    failInvalidOption(`${field} must not be empty.`);
  }
  if (normalized.length > maxLength) {
    failInvalidOption(`${field} must be at most ${maxLength} characters.`);
  }
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if (code < 32 || code === 127) {
      failInvalidOption(`${field} must not include control characters.`);
    }
  }
  return normalized;
}

export function validateRuntimeModeInput(rawMode: unknown): string {
  return validateBoundedText(rawMode, "Runtime mode", MAX_RUNTIME_MODE_LENGTH);
}

export function validateRuntimeModelInput(rawModel: unknown): string {
  return validateBoundedText(rawModel, "Model id", MAX_MODEL_LENGTH);
}

function validateRuntimeThinkingInput(rawThinking: unknown): string {
  return validateBoundedText(rawThinking, "Thinking level", MAX_THINKING_LENGTH);
}

export function validateRuntimePermissionProfileInput(rawProfile: unknown): string {
  return validateBoundedText(rawProfile, "Permission profile", MAX_PERMISSION_PROFILE_LENGTH);
}

export function validateRuntimeCwdInput(rawCwd: unknown): string {
  const cwd = validateBoundedText(rawCwd, "Working directory", MAX_CWD_LENGTH);
  if (!isAbsolute(cwd)) {
    failInvalidOption(`Working directory must be an absolute path. Received "${cwd}".`);
  }
  return cwd;
}

function validateRuntimeTimeoutSecondsInput(rawTimeout: unknown): number {
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout)) {
    failInvalidOption("Timeout must be a positive integer in seconds.");
  }
  const timeout = Math.round(rawTimeout);
  if (timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS) {
    failInvalidOption(
      `Timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return timeout;
}

export function parseRuntimeTimeoutSecondsInput(rawTimeout: unknown): number {
  const normalized = normalizeText(rawTimeout);
  if (!normalized || !/^\d+$/.test(normalized)) {
    failInvalidOption("Timeout must be a positive integer in seconds.");
  }
  return validateRuntimeTimeoutSecondsInput(parseStrictPositiveInteger(normalized) ?? 0);
}

export function validateRuntimeConfigOptionInput(
  rawKey: unknown,
  rawValue: unknown,
): {
  key: string;
  value: string;
} {
  const key = validateBoundedText(rawKey, "ACP config key", MAX_BACKEND_OPTION_KEY_LENGTH);
  if (!SAFE_OPTION_KEY_RE.test(key)) {
    failInvalidOption(
      "ACP config key must use letters, numbers, dots, colons, underscores, or dashes.",
    );
  }
  return {
    key,
    value: validateBoundedText(rawValue, "ACP config value", MAX_BACKEND_OPTION_VALUE_LENGTH),
  };
}

export function validateRuntimeOptionPatch(
  patch: Partial<AcpSessionRuntimeOptions> | undefined,
): Partial<AcpSessionRuntimeOptions> {
  if (!patch) {
    return {};
  }
  const rawPatch = patch as Record<string, unknown>;
  const allowedKeys = new Set([
    "runtimeMode",
    "model",
    "thinking",
    "cwd",
    "permissionProfile",
    "timeoutSeconds",
    "backendExtras",
  ]);
  for (const key of Object.keys(rawPatch)) {
    if (!allowedKeys.has(key)) {
      failInvalidOption(`Unknown runtime option "${key}".`);
    }
  }

  const next: Partial<AcpSessionRuntimeOptions> = {};
  function setOption<K extends Exclude<keyof AcpSessionRuntimeOptions, "backendExtras">>(
    key: K,
    validate: (value: unknown) => AcpSessionRuntimeOptions[K],
  ): void {
    // Own undefined clears an option; missing and inherited fields leave it unchanged.
    if (Object.hasOwn(rawPatch, key)) {
      next[key] = rawPatch[key] === undefined ? undefined : validate(rawPatch[key]);
    }
  }
  setOption("runtimeMode", validateRuntimeModeInput);
  setOption("model", validateRuntimeModelInput);
  setOption("thinking", validateRuntimeThinkingInput);
  setOption("cwd", validateRuntimeCwdInput);
  setOption("permissionProfile", validateRuntimePermissionProfileInput);
  setOption("timeoutSeconds", validateRuntimeTimeoutSecondsInput);
  if (Object.hasOwn(rawPatch, "backendExtras")) {
    const rawExtras = rawPatch.backendExtras;
    if (rawExtras === undefined) {
      next.backendExtras = undefined;
    } else if (!rawExtras || typeof rawExtras !== "object" || Array.isArray(rawExtras)) {
      failInvalidOption("Backend extras must be a key/value object.");
    } else {
      const entries = Object.entries(rawExtras);
      if (entries.length > MAX_BACKEND_EXTRAS) {
        failInvalidOption(`Backend extras must include at most ${MAX_BACKEND_EXTRAS} entries.`);
      }
      const extras: Record<string, string> = {};
      for (const [entryKey, entryValue] of entries) {
        const { key, value } = validateRuntimeConfigOptionInput(entryKey, entryValue);
        extras[key] = value;
      }
      next.backendExtras = Object.keys(extras).length > 0 ? extras : undefined;
    }
  }

  return next;
}

export function normalizeRuntimeOptions(
  options: AcpSessionRuntimeOptions | undefined,
): AcpSessionRuntimeOptions {
  const normalized: AcpSessionRuntimeOptions = {};
  for (const key of ["runtimeMode", "model", "thinking", "cwd", "permissionProfile"] as const) {
    const value = normalizeText(options?.[key]);
    if (value) {
      normalized[key] = value;
    }
  }
  if (typeof options?.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds)) {
    const rounded = Math.round(options.timeoutSeconds);
    if (rounded > 0) {
      normalized.timeoutSeconds = rounded;
    }
  }
  const backendExtrasEntries = Object.entries(options?.backendExtras ?? {})
    .map(([key, value]) => [normalizeText(key), normalizeText(value)] as const)
    .filter(([key, value]) => Boolean(key && value)) as Array<[string, string]>;
  if (backendExtrasEntries.length > 0) {
    normalized.backendExtras = Object.fromEntries(backendExtrasEntries);
  }
  return normalized;
}

/** Inputs have already passed manager validation and metadata normalization. */
export function mergeRuntimeOptions({
  current = {},
  patch = {},
}: {
  current?: AcpSessionRuntimeOptions;
  patch?: Partial<AcpSessionRuntimeOptions>;
}): AcpSessionRuntimeOptions {
  return normalizeRuntimeOptions({
    ...current,
    ...patch,
    ...(patch.backendExtras
      ? { backendExtras: { ...current.backendExtras, ...patch.backendExtras } }
      : {}),
  });
}

export function isThinkingConfigKey(key: string): boolean {
  return RUNTIME_CONFIG_OPTION_ALIASES.thinking.some(
    (alias) => alias === normalizeLowercaseStringOrEmpty(key),
  );
}

/** Reconcile only selected thinking; backend defaults must not become new session overrides. */
export function reconcileAcceptedRuntimeOptions(
  options: AcpSessionRuntimeOptions,
  result: AcpRuntimeConfigOptionResult | void,
  pendingThinking?: string,
): AcpSessionRuntimeOptions {
  if (!result || !options.thinking) {
    return options;
  }
  const thinking = result.configOptions.find(
    (option) => option.category === "thought_level" || isThinkingConfigKey(option.id),
  );
  // Automatic model replay precedes thinking; a still-valid pending selection must survive it.
  if (
    pendingThinking &&
    (thinking?.currentValue === pendingThinking ||
      thinking?.options?.some((choice) =>
        "options" in choice
          ? choice.options.some((option) => option.value === pendingThinking)
          : choice.value === pendingThinking,
      ))
  ) {
    return options;
  }
  return normalizeRuntimeOptions({
    ...options,
    thinking: typeof thinking?.currentValue === "string" ? thinking.currentValue : undefined,
  });
}

export function resolveRuntimeOptionsFromMeta(meta: SessionAcpMeta): AcpSessionRuntimeOptions {
  return normalizeRuntimeOptions({
    ...meta.runtimeOptions,
    cwd: normalizeText(meta.runtimeOptions?.cwd) ?? meta.cwd,
  });
}

export function runtimeOptionsEqual(
  a: AcpSessionRuntimeOptions | undefined,
  b: AcpSessionRuntimeOptions | undefined,
): boolean {
  return JSON.stringify(normalizeRuntimeOptions(a)) === JSON.stringify(normalizeRuntimeOptions(b));
}

export function buildRuntimeControlSignature(options: AcpSessionRuntimeOptions): string {
  const extras = Object.entries(options.backendExtras ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify({
    runtimeMode: options.runtimeMode ?? null,
    model: options.model ?? null,
    thinking: options.thinking ?? null,
    permissionProfile: options.permissionProfile ?? null,
    timeoutSeconds: options.timeoutSeconds ?? null,
    backendExtras: extras,
  });
}

export function buildRuntimeConfigOptionPairs(
  options: AcpSessionRuntimeOptions,
  advertisedConfigOptionKeys?: readonly string[],
): Array<[string, string]> {
  const pairs = new Map<string, string>();
  const advertisedKeys = buildAdvertisedConfigOptionKeyMap(advertisedConfigOptionKeys);
  const resolveKey = (key: string) => resolveRuntimeConfigOptionKeyFromMap(key, advertisedKeys);
  const shouldEmit = (aliases: readonly string[]) =>
    advertisedKeys.size === 0 || aliases.some((alias) => advertisedKeys.has(alias));
  if (options.model) {
    pairs.set(resolveKey("model"), options.model);
  }
  if (options.thinking && shouldEmit(RUNTIME_CONFIG_OPTION_ALIASES.thinking)) {
    pairs.set(resolveKey("thinking"), options.thinking);
  }
  if (options.permissionProfile) {
    pairs.set(resolveKey("approval_policy"), options.permissionProfile);
  }
  if (
    options.timeoutSeconds !== undefined &&
    shouldEmit(RUNTIME_CONFIG_OPTION_ALIASES.timeoutSeconds)
  ) {
    pairs.set(resolveKey("timeout"), String(options.timeoutSeconds));
  }
  for (const [key, value] of Object.entries(options.backendExtras ?? {})) {
    const wireKey = resolveKey(key);
    if (!pairs.has(wireKey)) {
      pairs.set(wireKey, value);
    }
  }
  return [...pairs.entries()];
}

function buildAdvertisedConfigOptionKeyMap(
  advertisedConfigOptionKeys?: readonly string[],
): Map<string, string> {
  const advertisedKeys = new Map<string, string>();
  for (const rawKey of advertisedConfigOptionKeys ?? []) {
    const key = normalizeText(rawKey);
    if (key && !advertisedKeys.has(key.toLowerCase())) {
      advertisedKeys.set(key.toLowerCase(), key);
    }
  }
  return advertisedKeys;
}

export function resolveRuntimeConfigOptionKey(
  key: string,
  advertisedConfigOptionKeys?: readonly string[],
): string {
  return resolveRuntimeConfigOptionKeyFromMap(
    key,
    buildAdvertisedConfigOptionKeyMap(advertisedConfigOptionKeys),
  );
}

function resolveRuntimeConfigOptionKeyFromMap(
  key: string,
  advertisedKeys: ReadonlyMap<string, string>,
): string {
  const normalizedKey = normalizeText(key) ?? "";
  const normalizedLookupKey = normalizedKey.toLowerCase();
  if (!normalizedKey || advertisedKeys.size === 0) {
    return normalizedKey;
  }
  const exactAdvertisedKey = advertisedKeys.get(normalizedLookupKey);
  if (exactAdvertisedKey) {
    return exactAdvertisedKey;
  }
  const aliases = Object.values(RUNTIME_CONFIG_OPTION_ALIASES).find((group) =>
    group.some((alias) => alias === normalizedLookupKey),
  );
  for (const alias of aliases ?? []) {
    const advertisedAlias = advertisedKeys.get(alias);
    if (advertisedAlias) {
      return advertisedAlias;
    }
  }
  return normalizedKey;
}

export function inferRuntimeOptionPatchFromConfigOption(
  key: string,
  value: string,
): Partial<AcpSessionRuntimeOptions> {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "model") {
    return { model: validateRuntimeModelInput(value) };
  }
  if (isThinkingConfigKey(normalizedKey)) {
    return { thinking: validateRuntimeThinkingInput(value) };
  }
  if (RUNTIME_CONFIG_OPTION_ALIASES.permissionProfile.some((alias) => alias === normalizedKey)) {
    return { permissionProfile: validateRuntimePermissionProfileInput(value) };
  }
  if (RUNTIME_CONFIG_OPTION_ALIASES.timeoutSeconds.some((alias) => alias === normalizedKey)) {
    return { timeoutSeconds: parseRuntimeTimeoutSecondsInput(value) };
  }
  if (normalizedKey === "cwd") {
    return { cwd: validateRuntimeCwdInput(value) };
  }
  return {
    backendExtras: {
      [key]: value,
    },
  };
}
