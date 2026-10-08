import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";
import {
  asBoolean as readBoolean,
  asNonArrayRecord,
  isRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { collectPolicyConfiguredAgents, ocPathSegment } from "./policy-state-helpers.js";
import type {
  PolicyAuthProfileEvidence,
  PolicyDataHandlingEvidence,
  PolicyEvidenceBuilder,
  PolicySecretEvidence,
  SecretRefDefaults,
} from "./policy-state-types.js";

export function scanPolicySecrets(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  const entries = [...scanPolicySecretProviders(cfg)];
  collectSecretInputs(entries, cfg, [], secretRefDefaults(asNonArrayRecord(cfg.secrets).defaults));
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

export function scanPolicyAuthProfiles(
  cfg: Record<string, unknown>,
): readonly PolicyAuthProfileEvidence[] {
  const auth = asNonArrayRecord(cfg.auth);
  const profiles = asNonArrayRecord(auth.profiles);
  return Object.entries(profiles)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: PolicyEvidenceBuilder<PolicyAuthProfileEvidence> = {
        id,
        source: `oc://openclaw.config/auth/profiles/${ocPathSegment(id)}`,
        validMetadata: isValidAuthProfileMetadata(value),
      };
      if (isRecord(value)) {
        if (typeof value.provider === "string") {
          entry.provider = value.provider;
        }
        if (typeof value.mode === "string") {
          entry.mode = value.mode;
        }
      }
      return entry;
    });
}

export function scanPolicyDataHandling(
  cfg: Record<string, unknown>,
): readonly PolicyDataHandlingEvidence[] {
  const entries: PolicyDataHandlingEvidence[] = [];
  // Redaction has no config surface: src/logging/redact.ts always redacts. This invariant
  // record is how dataHandling.sensitiveLogging.requireRedaction reports as satisfied in
  // `openclaw policy check` evidence and the attestation, since no doctor check can fail.
  entries.push({
    id: "logging-redaction",
    kind: "sensitiveLoggingRedaction",
    source: "oc://openclaw.invariant/logging/redaction",
    scope: "global",
    value: true,
    explicit: true,
  });

  const diagnostics = asNonArrayRecord(cfg.diagnostics);
  const otel = asNonArrayRecord(diagnostics.otel);
  const otelEnabled = diagnostics.enabled !== false && otel.enabled === true;
  const tracesEnabled = otelEnabled && otel.traces !== false;
  const logsEnabled = otelEnabled && otel.logs === true;
  const captureContent =
    otelEnabled &&
    telemetryContentCaptureEnabled(otel.captureContent, {
      tracesEnabled,
      logsEnabled,
    });
  entries.push({
    id: "diagnostics-otel-content-capture",
    kind: "telemetryContentCapture",
    source: "oc://openclaw.config/diagnostics/otel/captureContent",
    scope: "global",
    value: captureContent,
    explicit: otel.captureContent !== undefined,
  });

  const session = asNonArrayRecord(cfg.session);
  const maintenance = asNonArrayRecord(session.maintenance);
  const retentionMode = typeof maintenance.mode === "string" ? maintenance.mode : "enforce";
  entries.push({
    id: "session-maintenance-mode",
    kind: "sessionRetentionMode",
    source: "oc://openclaw.config/session/maintenance/mode",
    scope: "global",
    value: retentionMode,
    explicit: maintenance.mode !== undefined,
  });

  pushMemorySessionTranscriptIndexing(entries, cfg);
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

function telemetryContentCaptureEnabled(
  value: unknown,
  signals: { readonly tracesEnabled: boolean; readonly logsEnabled: boolean },
): boolean {
  if (value === true) {
    return signals.tracesEnabled || signals.logsEnabled;
  }
  if (!isRecord(value) || !signals.tracesEnabled || value.enabled !== true) {
    return false;
  }
  return (
    value.inputMessages === true ||
    value.outputMessages === true ||
    value.toolInputs === true ||
    value.toolOutputs === true ||
    value.systemPrompt === true ||
    value.toolDefinitions === true
  );
}

function pushMemorySessionTranscriptIndexing(
  entries: PolicyDataHandlingEvidence[],
  cfg: Record<string, unknown>,
): void {
  const memory = asNonArrayRecord(cfg.memory);
  const defaultsMemorySearch = asNonArrayRecord(memory.search);
  const defaultSessionMemory = memorySearchSessionTranscriptIndexing(defaultsMemorySearch);
  if (defaultSessionMemory !== undefined) {
    const defaultExperimental = asNonArrayRecord(defaultsMemorySearch.experimental);
    entries.push({
      id: "agents-defaults-memory-session-transcripts",
      kind: "memorySessionTranscriptIndexing",
      source:
        readBoolean(defaultsMemorySearch.rememberAcrossConversations) === undefined &&
        readBoolean(defaultExperimental.sessionMemory) !== undefined
          ? "oc://openclaw.config/memory/search/experimental/sessionMemory"
          : "oc://openclaw.config/memory/search/rememberAcrossConversations",
      scope: "global",
      value: defaultSessionMemory,
      explicit: true,
    });
  }

  const agents = asNonArrayRecord(cfg.agents);
  collectPolicyConfiguredAgents(agents).forEach((configured) => {
    const { agentId, value: rawAgent } = configured;
    if (!isRecord(rawAgent)) {
      return;
    }
    const agentMemory = isRecord(rawAgent.memory) ? rawAgent.memory : undefined;
    const memorySearch = isRecord(agentMemory?.search) ? agentMemory.search : undefined;
    const agentSessionMemory =
      memorySearch === undefined
        ? defaultSessionMemory
        : memorySearchSessionTranscriptIndexing(memorySearch, defaultsMemorySearch);
    if (agentSessionMemory === undefined) {
      return;
    }
    const explicit = readMemorySessionSettings(memorySearch).explicit;
    const experimental = asNonArrayRecord(memorySearch?.experimental);
    entries.push({
      id: `${agentId}-memory-session-transcripts`,
      kind: "memorySessionTranscriptIndexing",
      source: explicit
        ? readBoolean(memorySearch?.rememberAcrossConversations) === undefined &&
          readBoolean(experimental.sessionMemory) !== undefined
          ? `${configured.sourceBase}/memory/search/experimental/sessionMemory`
          : `${configured.sourceBase}/memory/search/rememberAcrossConversations`
        : "oc://openclaw.config/memory/search/rememberAcrossConversations",
      scope: "agent",
      agentId: normalizeAgentId(agentId),
      value: agentSessionMemory,
      explicit,
    });
  });
}

function memorySearchSessionTranscriptIndexing(
  memorySearch: unknown,
  inheritedMemorySearch?: unknown,
): boolean | undefined {
  if (!isRecord(memorySearch)) {
    return undefined;
  }
  const local = readMemorySessionSettings(memorySearch);
  const inherited = readMemorySessionSettings(inheritedMemorySearch);
  const rememberAcrossConversations = local.remember ?? inherited.remember;
  if (rememberAcrossConversations === undefined && !local.explicit) {
    return undefined;
  }
  return (
    (local.enabled ?? inherited.enabled ?? true) &&
    rememberAcrossConversations === true &&
    (local.sessions ?? inherited.sessions ?? false)
  );
}

function readMemorySessionSettings(value: unknown) {
  const search = asNonArrayRecord(value);
  const enabled = readBoolean(search.enabled);
  const remember =
    readBoolean(search.rememberAcrossConversations) ??
    readBoolean(asNonArrayRecord(search.experimental).sessionMemory);
  const sessions =
    search.sources === undefined
      ? undefined
      : Array.isArray(search.sources) && search.sources.includes("sessions");
  return {
    enabled,
    remember,
    sessions,
    explicit: enabled !== undefined || remember !== undefined || sessions !== undefined,
  };
}

function scanPolicySecretProviders(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  const secrets = asNonArrayRecord(cfg.secrets);
  const providers = asNonArrayRecord(secrets.providers);
  return Object.entries(providers).map(([id, value]) => {
    const entry: PolicyEvidenceBuilder<PolicySecretEvidence> = {
      id,
      kind: "provider",
      source: `oc://openclaw.config/secrets/providers/${ocPathSegment(id)}`,
    };
    if (isRecord(value) && typeof value.source === "string") {
      entry.providerSource = value.source;
    }
    return entry;
  });
}

function collectSecretInputs(
  entries: PolicySecretEvidence[],
  value: unknown,
  path: readonly string[],
  defaults: SecretRefDefaults | undefined,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSecretInputs(entries, item, [...path, `#${index}`], defaults),
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const source = `oc://openclaw.config/${childPath.map(ocPathSegment).join("/")}`;
    const secretInputPath = isSecretInputPath(childPath);
    const ref = secretInputPath ? coerceSecretRef(child, defaults) : null;
    if (ref !== null) {
      entries.push({
        id: source,
        kind: "input",
        source,
        provenance: "secretRef",
        refSource: ref.source,
        refProvider: ref.provider,
      });
      continue;
    }
    collectSecretInputs(entries, child, childPath, defaults);
  }
}

function isSecretInputPath(path: readonly string[]): boolean {
  const key = path.at(-1);
  if (key === undefined) {
    return false;
  }
  if (
    matchesConfigPath(path, ["plugins", "entries", "acpx", "config", "mcpServers", "*", "env", "*"])
  ) {
    return true;
  }
  if (path.at(-2) === "env") {
    return false;
  }
  if (isSecretInputKey(key)) {
    return true;
  }
  return (
    [
      ["models", "providers", "*", "headers", "*"],
      ["memory", "search", "remote", "headers", "*"],
      ["agents", "entries", "*", "memory", "search", "remote", "headers", "*"],
      ["agents", "list", "#", "memory", "search", "remote", "headers", "*"],
      ["diagnostics", "otel", "headers", "*"],
    ].some((pattern) => matchesConfigPath(path, pattern)) ||
    [
      ["models", "providers", "*"],
      ["tools", "media", "models", "#"],
      ["tools", "media", "audio"],
      ["tools", "media", "image"],
      ["tools", "media", "video"],
    ].some((prefix) => isConfiguredProviderRequestSecretPath(path, prefix))
  );
}

function isConfiguredProviderRequestSecretPath(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  if (!matchesConfigPathPrefix(path, prefix) || path[prefix.length] !== "request") {
    return false;
  }
  const suffix = path.slice(prefix.length + 1);
  if (suffix.length === 2) {
    return (
      suffix[0] === "headers" ||
      (suffix[0] === "auth" && (suffix[1] === "token" || suffix[1] === "value")) ||
      (suffix[0] === "tls" && isConfiguredProviderTlsSecretKey(suffix[1]))
    );
  }
  return (
    suffix.length === 3 &&
    suffix[0] === "proxy" &&
    suffix[1] === "tls" &&
    isConfiguredProviderTlsSecretKey(suffix[2])
  );
}

function matchesConfigPathPrefix(path: readonly string[], prefix: readonly string[]): boolean {
  if (path.length < prefix.length) {
    return false;
  }
  return prefix.every((segment, index) => {
    const value = path[index];
    if (segment === "*") {
      return value !== undefined && value !== "";
    }
    if (segment === "#") {
      return value?.startsWith("#") ?? false;
    }
    return value === segment;
  });
}

function matchesConfigPath(path: readonly string[], pattern: readonly string[]): boolean {
  return path.length === pattern.length && matchesConfigPathPrefix(path, pattern);
}

function isConfiguredProviderTlsSecretKey(key: string | undefined): boolean {
  return key === "ca" || key === "cert" || key === "key" || key === "passphrase";
}

function isSecretInputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "keyref" ||
    normalized === "tokenref" ||
    normalized === "encryptkey" ||
    normalized === "serviceaccount" ||
    normalized === "serviceaccountref" ||
    normalized === "privatekey" ||
    normalized === "certificate" ||
    normalized === "certificatedata" ||
    normalized === "identitydata" ||
    normalized === "knownhosts" ||
    normalized === "knownhostsdata" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

function secretRefDefaults(value: unknown): SecretRefDefaults | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const defaults: SecretRefDefaults = {};
  for (const source of ["env", "file", "exec", "store"] as const) {
    if (typeof value[source] === "string") {
      defaults[source] = value[source];
    }
  }
  return defaults;
}

function isValidAuthProfileMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.provider === "string" &&
    value.provider.trim() !== "" &&
    isAuthProfileMode(value.mode)
  );
}

function isAuthProfileMode(value: unknown): boolean {
  return value === "api_key" || value === "aws-sdk" || value === "oauth" || value === "token";
}
