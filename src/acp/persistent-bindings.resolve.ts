import { listAcpBindings } from "../config/bindings.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentAcpBinding } from "../config/types.js";
import { pickFirstExistingAgentId } from "../routing/resolve-route.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { parseTelegramTopicConversation } from "./conversation-id.js";
import {
  buildConfiguredAcpSessionKey,
  normalizeBindingConfig,
  normalizeMode,
  normalizeText,
  toConfiguredAcpBindingRecord,
  type ConfiguredAcpBindingChannel,
  type ConfiguredAcpBindingSpec,
  type ResolvedConfiguredAcpBinding,
} from "./persistent-bindings.types.js";

function normalizeBindingChannel(value: string | undefined): ConfiguredAcpBindingChannel | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "discord" || normalized === "telegram") {
    return normalized;
  }
  return null;
}

function matchesAccountId(match: string | undefined, actual: string): boolean {
  const trimmed = (match ?? "").trim();
  if (!trimmed) {
    return actual === DEFAULT_ACCOUNT_ID;
  }
  if (trimmed === "*") {
    return true;
  }
  return normalizeAccountId(trimmed) === actual;
}

function resolveBindingConversationId(binding: AgentAcpBinding): string | null {
  const id = binding.match.peer?.id?.trim();
  return id ? id : null;
}

function parseConfiguredBindingSessionKey(params: {
  sessionKey: string;
}): { channel: ConfiguredAcpBindingChannel; accountId: string } | null {
  const parsed = parseAgentSessionKey(params.sessionKey);
  const rest = parsed?.rest?.trim().toLowerCase() ?? "";
  if (!rest) {
    return null;
  }
  const tokens = rest.split(":");
  if (tokens.length !== 5 || tokens[0] !== "acp" || tokens[1] !== "binding") {
    return null;
  }
  const channel = normalizeBindingChannel(tokens[2]);
  if (!channel) {
    return null;
  }
  const accountId = normalizeAccountId(tokens[3]);
  return {
    channel,
    accountId,
  };
}

function resolveAgentRuntimeAcpDefaults(params: { cfg: OpenClawConfig; ownerAgentId: string }): {
  acpAgentId?: string;
  mode?: string;
  cwd?: string;
  backend?: string;
} {
  const agent = params.cfg.agents?.list?.find(
    (entry) => entry.id?.trim().toLowerCase() === params.ownerAgentId.toLowerCase(),
  );
  if (!agent || agent.runtime?.type !== "acp") {
    return {};
  }
  return {
    acpAgentId: normalizeText(agent.runtime.acp?.agent),
    mode: normalizeText(agent.runtime.acp?.mode),
    cwd: normalizeText(agent.runtime.acp?.cwd),
    backend: normalizeText(agent.runtime.acp?.backend),
  };
}

function toConfiguredBindingSpec(params: {
  cfg: OpenClawConfig;
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  binding: AgentAcpBinding;
}): ConfiguredAcpBindingSpec {
  const accountId = normalizeAccountId(params.accountId);
  const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
  const runtimeDefaults = resolveAgentRuntimeAcpDefaults({
    cfg: params.cfg,
    ownerAgentId: agentId,
  });
  const bindingOverrides = normalizeBindingConfig(params.binding.acp);
  const acpAgentId = normalizeText(runtimeDefaults.acpAgentId);
  const mode = normalizeMode(bindingOverrides.mode ?? runtimeDefaults.mode);
  return {
    channel: params.channel,
    accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
    agentId,
    acpAgentId,
    mode,
    cwd: bindingOverrides.cwd ?? runtimeDefaults.cwd,
    backend: bindingOverrides.backend ?? runtimeDefaults.backend,
    label: bindingOverrides.label,
  };
}

export function resolveConfiguredAcpBindingSpecBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredAcpBindingSpec | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const parsedSessionKey = parseConfiguredBindingSessionKey({ sessionKey });
  if (!parsedSessionKey) {
    return null;
  }
  for (const binding of listAcpBindings(params.cfg)) {
    const channel = normalizeBindingChannel(binding.match.channel);
    if (!channel || channel !== parsedSessionKey.channel) {
      continue;
    }
    if (!matchesAccountId(binding.match.accountId, parsedSessionKey.accountId)) {
      continue;
    }
    const targetConversationId = resolveBindingConversationId(binding);
    if (!targetConversationId) {
      continue;
    }
    if (channel === "discord") {
      const spec = toConfiguredBindingSpec({
        cfg: params.cfg,
        channel: "discord",
        accountId: parsedSessionKey.accountId,
        conversationId: targetConversationId,
        binding,
      });
      if (buildConfiguredAcpSessionKey(spec) === sessionKey) {
        return spec;
      }
      continue;
    }
    const parsedTopic = parseTelegramTopicConversation({
      conversationId: targetConversationId,
    });
    if (!parsedTopic || !parsedTopic.chatId.startsWith("-")) {
      continue;
    }
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel: "telegram",
      accountId: parsedSessionKey.accountId,
      conversationId: parsedTopic.canonicalConversationId,
      parentConversationId: parsedTopic.chatId,
      binding,
    });
    if (buildConfiguredAcpSessionKey(spec) === sessionKey) {
      return spec;
    }
  }
  return null;
}

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const channel = params.channel.trim().toLowerCase();
  const accountId = normalizeAccountId(params.accountId);
  const conversationId = params.conversationId.trim();
  const parentConversationId = params.parentConversationId?.trim() || undefined;
  if (!conversationId) {
    return null;
  }

  if (channel === "discord") {
    const candidates = new Set(
      [conversationId, parentConversationId].filter((value): value is string => Boolean(value)),
    );
    for (const binding of listAcpBindings(params.cfg)) {
      if (normalizeBindingChannel(binding.match.channel) !== "discord") {
        continue;
      }
      if (!matchesAccountId(binding.match.accountId, accountId)) {
        continue;
      }
      const targetConversationId = resolveBindingConversationId(binding);
      if (!targetConversationId || !candidates.has(targetConversationId)) {
        continue;
      }
      const spec = toConfiguredBindingSpec({
        cfg: params.cfg,
        channel: "discord",
        accountId,
        conversationId: targetConversationId,
        binding,
      });
      return {
        spec,
        record: toConfiguredAcpBindingRecord(spec),
      };
    }
    return null;
  }

  if (channel === "telegram") {
    const parsed = parseTelegramTopicConversation({
      conversationId,
      parentConversationId,
    });
    if (!parsed || !parsed.chatId.startsWith("-")) {
      return null;
    }
    for (const binding of listAcpBindings(params.cfg)) {
      if (normalizeBindingChannel(binding.match.channel) !== "telegram") {
        continue;
      }
      if (!matchesAccountId(binding.match.accountId, accountId)) {
        continue;
      }
      const targetConversationId = resolveBindingConversationId(binding);
      if (!targetConversationId) {
        continue;
      }
      const targetParsed = parseTelegramTopicConversation({
        conversationId: targetConversationId,
      });
      if (!targetParsed || !targetParsed.chatId.startsWith("-")) {
        continue;
      }
      if (targetParsed.canonicalConversationId !== parsed.canonicalConversationId) {
        continue;
      }
      const spec = toConfiguredBindingSpec({
        cfg: params.cfg,
        channel: "telegram",
        accountId,
        conversationId: parsed.canonicalConversationId,
        parentConversationId: parsed.chatId,
        binding,
      });
      return {
        spec,
        record: toConfiguredAcpBindingRecord(spec),
      };
    }
    return null;
  }

  return null;
}
