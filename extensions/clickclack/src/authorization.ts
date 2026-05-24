import type { CoreConfig, ClickClackMessage, ResolvedClickClackAccount } from "./types.js";

const CHANNEL_ID = "clickclack" as const;

function normalizeAllowEntry(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function formatClickClackAllowFrom(params: { allowFrom: Array<string | number> }): string[] {
  const formatted = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeAllowEntry(value);
    if (normalized) {
      formatted.add(normalized);
    }
  };
  for (const entry of params.allowFrom) {
    const normalized = normalizeAllowEntry(entry);
    if (!normalized) {
      continue;
    }
    push(normalized);
    if (normalized === "*") {
      continue;
    }
    if (normalized.startsWith(`${CHANNEL_ID}:channel:`)) {
      push(normalized.slice(`${CHANNEL_ID}:`.length));
      continue;
    }
    if (normalized.startsWith(`${CHANNEL_ID}:`)) {
      push(normalized.slice(`${CHANNEL_ID}:`.length));
      continue;
    }
    if (normalized.startsWith("channel:")) {
      push(`${CHANNEL_ID}:${normalized}`);
      continue;
    }
    if (!normalized.includes(":")) {
      push(`${CHANNEL_ID}:${normalized}`);
    }
  }
  return [...formatted];
}

export function resolveClickClackSenderInAllowList(params: {
  allowFrom: readonly unknown[];
  message: ClickClackMessage;
  target?: string;
  includeConversationCandidates?: boolean;
}): boolean {
  const allowFrom = formatClickClackAllowFrom({
    allowFrom: params.allowFrom.map((entry) => String(entry ?? "")),
  });
  if (allowFrom.includes("*")) {
    return true;
  }
  const includeConversationCandidates = params.includeConversationCandidates !== false;
  const candidates = [
    params.message.author_id,
    `${CHANNEL_ID}:${params.message.author_id}`,
    ...(includeConversationCandidates
      ? [
          params.target,
          params.target ? `${CHANNEL_ID}:${params.target}` : undefined,
          params.message.channel_id ? `channel:${params.message.channel_id}` : undefined,
          params.message.channel?.name ? `channel:${params.message.channel.name}` : undefined,
          params.message.channel?.id
            ? `${CHANNEL_ID}:channel:${params.message.channel.id}`
            : undefined,
          params.message.channel?.name
            ? `${CHANNEL_ID}:channel:${params.message.channel.name}`
            : undefined,
        ]
      : []),
  ]
    .map(normalizeAllowEntry)
    .filter(Boolean);
  const allowed = new Set(allowFrom);
  return candidates.some((candidate) => allowed.has(candidate));
}

export function resolveClickClackSenderAllowed(params: {
  account: ResolvedClickClackAccount;
  message: ClickClackMessage;
  target?: string;
}): boolean {
  return resolveClickClackSenderInAllowList({
    allowFrom: params.account.allowFrom,
    message: params.message,
    target: params.target,
  });
}

export function resolveClickClackCommandsAllowFrom(
  config: CoreConfig,
): readonly unknown[] | undefined {
  const commandsAllowFrom = config.commands?.allowFrom;
  if (
    !commandsAllowFrom ||
    typeof commandsAllowFrom !== "object" ||
    Array.isArray(commandsAllowFrom)
  ) {
    return undefined;
  }
  const scoped = commandsAllowFrom[CHANNEL_ID] ?? commandsAllowFrom["*"];
  return Array.isArray(scoped) ? scoped : undefined;
}

export function resolveClickClackSenderAllowedForCommands(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
  target?: string;
}): boolean {
  const commandsAllowFrom = resolveClickClackCommandsAllowFrom(params.config);
  if (commandsAllowFrom) {
    return resolveClickClackSenderInAllowList({
      allowFrom: commandsAllowFrom,
      message: params.message,
      target: params.target,
    });
  }
  return resolveClickClackSenderAllowed({
    account: params.account,
    message: params.message,
    target: params.target,
  });
}

function resolveConfiguredOwnerAllowFrom(config: CoreConfig): readonly unknown[] | undefined {
  const ownerAllowFrom = config.commands?.ownerAllowFrom;
  return Array.isArray(ownerAllowFrom) ? ownerAllowFrom : undefined;
}

export function resolveClickClackSenderIsOwnerForCommands(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
  target?: string;
}): boolean {
  const ownerAllowFrom = resolveConfiguredOwnerAllowFrom(params.config);
  if (ownerAllowFrom) {
    return resolveClickClackSenderInAllowList({
      allowFrom: ownerAllowFrom,
      message: params.message,
      target: params.target,
      includeConversationCandidates: false,
    });
  }
  return false;
}

export function resolveClickClackCommandSuggestionAccess(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
  target?: string;
}): {
  accountAuthorized: boolean;
  commandAuthorized: boolean;
  senderIsOwner: boolean;
} {
  const accountAuthorized = resolveClickClackSenderAllowed({
    account: params.account,
    message: params.message,
    target: params.target,
  });
  if (!accountAuthorized) {
    return { accountAuthorized, commandAuthorized: false, senderIsOwner: false };
  }
  const commandAuthorized = resolveClickClackSenderAllowedForCommands(params);
  return {
    accountAuthorized,
    commandAuthorized,
    senderIsOwner:
      commandAuthorized &&
      resolveClickClackSenderIsOwnerForCommands({
        account: params.account,
        config: params.config,
        message: params.message,
        target: params.target,
      }),
  };
}
