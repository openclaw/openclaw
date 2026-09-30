// Policy plugin channel, model, MCP, and network evidence.
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { asNonArrayRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  collectPolicyConfiguredAgents,
  ocPathSegment,
  readBooleanPath,
} from "./policy-state-helpers.js";
import { RESERVED_CHANNEL_CONFIG_KEYS } from "./policy-state-types.js";
import type {
  PolicyChannelEvidence,
  PolicyEvidenceBuilder,
  PolicyMcpServerEvidence,
  PolicyModelProviderEvidence,
  PolicyModelRefEvidence,
  PolicyNetworkEvidence,
} from "./policy-state-types.js";

export function scanPolicyChannels(cfg: Record<string, unknown>): readonly PolicyChannelEvidence[] {
  return Object.entries(asNonArrayRecord(cfg.channels))
    .filter(([id]) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: PolicyEvidenceBuilder<PolicyChannelEvidence> = {
        id,
        provider: id,
        source: `oc://openclaw.config/channels/${id}`,
      };
      if (isRecord(value) && typeof value.enabled === "boolean") {
        entry.enabled = value.enabled;
      }
      return entry;
    });
}

export function scanPolicyMcpServers(
  cfg: Record<string, unknown>,
): readonly PolicyMcpServerEvidence[] {
  return Object.entries(asNonArrayRecord(asNonArrayRecord(cfg.mcp).servers))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: PolicyEvidenceBuilder<PolicyMcpServerEvidence> = {
        id,
        transport: mcpServerTransport(value),
        source: `oc://openclaw.config/mcp/servers/${ocPathSegment(id)}`,
      };
      if (isRecord(value)) {
        if (typeof value.command === "string") {
          entry.command = value.command;
        }
        if (typeof value.url === "string") {
          entry.url = redactMcpUrlForEvidence(value.url);
        }
      }
      return entry;
    });
}

export function scanPolicyModelProviders(
  cfg: Record<string, unknown>,
): readonly PolicyModelProviderEvidence[] {
  return Object.keys(asNonArrayRecord(asNonArrayRecord(cfg.models).providers))
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({
      id: normalizeProviderId(id),
      source: `oc://openclaw.config/models/providers/${id}`,
    }));
}

export function scanPolicyModelRefs(
  cfg: Record<string, unknown>,
): readonly PolicyModelRefEvidence[] {
  const refs: PolicyModelRefEvidence[] = [];
  if (isRecord(cfg.agents)) {
    collectModelRefsFromRecord(refs, cfg.agents, "oc://openclaw.config/agents");
    collectModelRefsFromAgentAllowlist(refs, cfg.agents);
  }
  return refs.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}

export function scanPolicyNetwork(cfg: Record<string, unknown>): readonly PolicyNetworkEvidence[] {
  return (
    [
      ["browser-private-network", ["browser", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"]],
      ["browser-private-network-legacy", ["browser", "ssrfPolicy", "allowPrivateNetwork"]],
      [
        "web-fetch-private-network",
        ["tools", "web", "fetch", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"],
      ],
      [
        "web-fetch-private-network-legacy",
        ["tools", "web", "fetch", "ssrfPolicy", "allowPrivateNetwork"],
      ],
      [
        "web-fetch-rfc2544-benchmark-range",
        ["tools", "web", "fetch", "ssrfPolicy", "allowRfc2544BenchmarkRange"],
      ],
      [
        "web-fetch-ipv6-unique-local-range",
        ["tools", "web", "fetch", "ssrfPolicy", "allowIpv6UniqueLocalRange"],
      ],
    ] as const
  ).flatMap(([id, path]) => {
    const value = readBooleanPath(cfg, path);
    return value === undefined
      ? []
      : [{ id, source: `oc://openclaw.config/${path.join("/")}`, value }];
  });
}

function mcpServerTransport(value: unknown): PolicyMcpServerEvidence["transport"] {
  if (!isRecord(value)) {
    return "unknown";
  }
  if (typeof value.command === "string") {
    return "stdio";
  }
  if (value.transport === "sse" || value.transport === "streamable-http") {
    return value.transport;
  }
  if (typeof value.url === "string") {
    return "streamable-http";
  }
  return "unknown";
}

function redactMcpUrlForEvidence(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[redacted-url]";
  }
}

function collectModelRefsFromValue(
  refs: PolicyModelRefEvidence[],
  value: unknown,
  source: string,
): void {
  if (typeof value === "string") {
    pushModelRef(refs, value, source);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.primary === "string") {
    pushModelRef(refs, value.primary, `${source}/primary`);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const [index, fallback] of value.fallbacks.entries()) {
      if (typeof fallback === "string") {
        pushModelRef(refs, fallback, `${source}/fallbacks/#${index}`);
      }
    }
  }
}

function collectModelRefsFromRecord(
  refs: PolicyModelRefEvidence[],
  value: Record<string, unknown>,
  source: string,
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${source}/${key}`;
    if (isModelSettingKey(key)) {
      collectModelRefsFromValue(refs, child, childPath);
      continue;
    }
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item)) {
          collectModelRefsFromRecord(refs, item, `${childPath}/#${index}`);
        }
      }
      continue;
    }
    if (isRecord(child)) {
      collectModelRefsFromRecord(refs, child, childPath);
    }
  }
}

function collectModelRefsFromAgentAllowlist(
  refs: PolicyModelRefEvidence[],
  agents: Record<string, unknown>,
): void {
  const defaults = agents.defaults;
  if (isRecord(defaults) && isRecord(defaults.models)) {
    collectModelRefsFromModelMap(
      refs,
      defaults.models,
      "oc://openclaw.config/agents/defaults/models",
    );
  }

  for (const configured of collectPolicyConfiguredAgents(agents)) {
    const agent = configured.value;
    if (!isRecord(agent) || !isRecord(agent.models)) {
      continue;
    }
    collectModelRefsFromModelMap(refs, agent.models, `${configured.sourceBase}/models`);
  }
}

function collectModelRefsFromModelMap(
  refs: PolicyModelRefEvidence[],
  models: Record<string, unknown>,
  source: string,
): void {
  for (const ref of Object.keys(models)) {
    pushModelRef(refs, ref, `${source}/${ocPathSegment(ref)}`);
  }
}

function isModelSettingKey(key: string): boolean {
  return key === "model" || key.endsWith("Model");
}

function pushModelRef(refs: PolicyModelRefEvidence[], ref: string, source: string): void {
  const parsed = parseModelRef(ref);
  if (parsed === undefined) {
    return;
  }
  refs.push({ ref, provider: parsed.provider, model: parsed.model, source });
}

function parseModelRef(
  ref: string,
): { readonly provider: string; readonly model: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: normalizeProviderId(trimmed.slice(0, slash)),
    model: trimmed.slice(slash + 1),
  };
}
