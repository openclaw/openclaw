import { getChannelPlugin } from "../channels/plugins/index.js";
import { listAcpBindings } from "../config/bindings.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentAcpBinding } from "../config/types.js";
import { pickFirstExistingAgentId } from "../routing/resolve-route.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
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
  if (!normalized) {
    return null;
  }
  const plugin = getChannelPlugin(normalized);
  return plugin?.acpBindings ? plugin.id : null;
}

function resolveAccountMatchPriority(match: string | undefined, actual: string): 0 | 1 | 2 {
  const trimmed = (match ?? "").trim();
  if (!trimmed) {
    return actual === DEFAULT_ACCOUNT_ID ? 2 : 0;
  }
  if (trimmed === "*") {
    return 1;
  }
  return normalizeAccountId(trimmed) === actual ? 2 : 0;
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
  return {
    channel,
    accountId: normalizeAccountId(tokens[3]),
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

function resolveConfiguredBindingRecord(params: {
  cfg: OpenClawConfig;
  bindings: AgentAcpBinding[];
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  selectConversation: (binding: AgentAcpBinding) => {
    conversationId: string;
    parentConversationId?: string;
    matchPriority?: number;
  } | null;
}): ResolvedConfiguredAcpBinding | null {
  let wildcardMatch: {
    binding: AgentAcpBinding;
    conversationId: string;
    parentConversationId?: string;
    matchPriority: number;
  } | null = null;
  let exactMatch: {
    binding: AgentAcpBinding;
    conversationId: string;
    parentConversationId?: string;
    matchPriority: number;
  } | null = null;
  for (const binding of params.bindings) {
    if (normalizeBindingChannel(binding.match.channel) !== params.channel) {
      continue;
    }
    const accountMatchPriority = resolveAccountMatchPriority(
      binding.match.accountId,
      params.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const conversation = params.selectConversation(binding);
    if (!conversation) {
      continue;
    }
    const matchPriority = conversation.matchPriority ?? 0;
    if (accountMatchPriority === 2) {
      if (!exactMatch || matchPriority > exactMatch.matchPriority) {
        exactMatch = {
          binding,
          conversationId: conversation.conversationId,
          parentConversationId: conversation.parentConversationId,
          matchPriority,
        };
      }
      continue;
    }
    if (!wildcardMatch || matchPriority > wildcardMatch.matchPriority) {
      wildcardMatch = {
        binding,
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
        matchPriority,
      };
    }
  }
  if (exactMatch) {
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      conversationId: exactMatch.conversationId,
      parentConversationId: exactMatch.parentConversationId,
      binding: exactMatch.binding,
    });
    return {
      spec,
      record: toConfiguredAcpBindingRecord(spec),
    };
  }
  if (!wildcardMatch) {
    return null;
  }
  const spec = toConfiguredBindingSpec({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    conversationId: wildcardMatch.conversationId,
    parentConversationId: wildcardMatch.parentConversationId,
    binding: wildcardMatch.binding,
  });
  return {
    spec,
    record: toConfiguredAcpBindingRecord(spec),
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
  const plugin = getChannelPlugin(parsedSessionKey.channel);
  const acpBindings = plugin?.acpBindings;
  if (!acpBindings?.normalizeConfiguredBindingTarget) {
    return null;
  }

  let wildcardMatch: ConfiguredAcpBindingSpec | null = null;
  for (const binding of listAcpBindings(params.cfg)) {
    const channel = normalizeBindingChannel(binding.match.channel);
    if (!channel || channel !== parsedSessionKey.channel) {
      continue;
    }
    const accountMatchPriority = resolveAccountMatchPriority(
      binding.match.accountId,
      parsedSessionKey.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const targetConversationId = resolveBindingConversationId(binding);
    if (!targetConversationId) {
      continue;
    }
    const target = acpBindings.normalizeConfiguredBindingTarget({
      binding,
      conversationId: targetConversationId,
    });
    if (!target) {
      continue;
    }
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel,
      accountId: parsedSessionKey.accountId,
      conversationId: target.conversationId,
      parentConversationId: target.parentConversationId,
      binding,
    });
    if (buildConfiguredAcpSessionKey(spec) !== sessionKey) {
      continue;
    }
    if (accountMatchPriority === 2) {
      return spec;
    }
    if (!wildcardMatch) {
      wildcardMatch = spec;
    }
  }
  return wildcardMatch;
}

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const channel = normalizeBindingChannel(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const conversationId = params.conversationId.trim();
  const parentConversationId = params.parentConversationId?.trim() || undefined;
  if (!channel || !conversationId) {
    return null;
  }
  const plugin = getChannelPlugin(channel);
  const acpBindings = plugin?.acpBindings;
  if (!acpBindings?.matchConfiguredBinding) {
    return null;
  }
  const matchConfiguredBinding = acpBindings.matchConfiguredBinding;

  return resolveConfiguredBindingRecord({
    cfg: params.cfg,
    bindings: listAcpBindings(params.cfg),
    channel,
    accountId,
    selectConversation: (binding) => {
      const bindingConversationId = resolveBindingConversationId(binding);
      if (!bindingConversationId) {
        return null;
      }
      return matchConfiguredBinding({
        binding,
        bindingConversationId,
        conversationId,
        parentConversationId,
      });
    },
  });
}
