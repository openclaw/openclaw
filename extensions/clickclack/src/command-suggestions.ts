import {
  listChatCommandsForConfig,
  listProviderPluginCommandSpecs,
  resolveCommandArgMenu,
  type ChatCommandDefinition,
  type CommandArgDefinition,
} from "openclaw/plugin-sdk/command-auth-native";
import { resolveClickClackCommandSuggestionAccess } from "./authorization.js";
import { buildClickClackTarget } from "./target.js";
import type {
  ClickClackChannel,
  ClickClackMessage,
  ClickClackUser,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

const CHANNEL_ID = "clickclack" as const;
const DEFAULT_LIMIT = 10;

type SkillCommands = NonNullable<Parameters<typeof listChatCommandsForConfig>[1]>["skillCommands"];
type PluginCommandSpec = ReturnType<typeof listProviderPluginCommandSpecs>[number] & {
  requiredScopes?: readonly string[];
};
type CommandWithSuggestionMeta = ChatCommandDefinition & {
  requiresOwner?: boolean;
};
type SuggestionSource = "core" | "skill" | "plugin";

export type ClickClackCommandSuggestionRequest = {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  query: string;
  senderId: string;
  sender?: Partial<ClickClackUser>;
  channelId?: string;
  channelName?: string;
  directConversationId?: string;
  limit?: number;
  skillCommands?: SkillCommands;
  pluginCommands?: PluginCommandSpec[];
};

export type ClickClackCommandSuggestion = {
  name: string;
  command: string;
  insertText: string;
  description: string;
  usage: string;
  preview: string;
  source: SuggestionSource;
  aliases: string[];
  acceptsArgs: boolean;
  requiresOwner?: boolean;
};

export type ClickClackCommandSuggestionResponse = {
  query: string;
  suggestions: ClickClackCommandSuggestion[];
  preview?: string;
  emptyText?: string;
};

type SuggestionEntry = {
  source: SuggestionSource;
  command?: ChatCommandDefinition;
  name: string;
  description: string;
  acceptsArgs: boolean;
  aliases: string[];
  requiresOwner?: boolean;
  order: number;
};

/**
 * Backend contract for ClickClack composer autocomplete.
 *
 * A ClickClack server/UI can call this resolver from an autocomplete endpoint
 * or slash-preview event without emitting normal chat messages. Request data is
 * the current composer query plus sender/channel identity; the response is a
 * compact list of insertable slash commands and an optional preview string.
 */
export function resolveClickClackCommandSuggestions(
  params: ClickClackCommandSuggestionRequest,
): ClickClackCommandSuggestionResponse {
  const query = params.query.trimStart();
  if (!query.startsWith("/")) {
    return {
      query,
      suggestions: [],
    };
  }
  const message = buildSuggestionMessage(params);
  const target = resolveSuggestionTarget(params);
  const access = resolveClickClackCommandSuggestionAccess({
    account: params.account,
    config: params.config,
    message,
    target,
  });
  if (!access.accountAuthorized || !access.commandAuthorized) {
    return {
      query,
      suggestions: [],
      emptyText: "No OpenClaw commands are available for this sender.",
    };
  }

  const normalizedToken = normalizeQueryToken(query);
  const entries = buildSuggestionEntries(params).filter(
    (entry) => !entry.requiresOwner || access.senderIsOwner,
  );
  const matched = entries
    .map((entry) => ({ entry, match: resolveMatch(entry, normalizedToken) }))
    .filter((item): item is { entry: SuggestionEntry; match: MatchInfo } => Boolean(item.match))
    .sort((a, b) => compareMatches(a, b));
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, 50));
  const suggestions = matched.slice(0, limit).map(({ entry, match }) =>
    buildSuggestion({
      entry,
      matchedName: match.name,
      cfg: params.config,
    }),
  );
  const preview = suggestions.find((suggestion) =>
    suggestionMatchesExactQuery(suggestion, normalizedToken),
  )?.preview;
  return {
    query,
    suggestions,
    ...(preview ? { preview } : {}),
    ...(suggestions.length === 0 ? { emptyText: "No matching OpenClaw command." } : {}),
  };
}

function buildSuggestionMessage(params: ClickClackCommandSuggestionRequest): ClickClackMessage {
  return {
    id: "clickclack-command-preview",
    workspace_id: params.account.workspace,
    channel_id: params.channelId,
    direct_conversation_id: params.directConversationId,
    author_id: params.senderId,
    thread_root_id: "clickclack-command-preview",
    body: params.query,
    body_format: "markdown",
    created_at: new Date(0).toISOString(),
    author: params.sender
      ? ({
          id: params.senderId,
          kind: params.sender.kind,
          owner_user_id: params.sender.owner_user_id,
          display_name: params.sender.display_name ?? params.senderId,
          handle: params.sender.handle ?? "",
          avatar_url: params.sender.avatar_url ?? "",
          created_at: params.sender.created_at ?? new Date(0).toISOString(),
        } satisfies ClickClackUser)
      : undefined,
    channel:
      params.channelId || params.channelName
        ? ({
            id: params.channelId ?? params.channelName ?? "",
            workspace_id: params.account.workspace,
            name: params.channelName ?? params.channelId ?? "",
            kind: "public",
            created_at: new Date(0).toISOString(),
          } satisfies ClickClackChannel)
        : undefined,
  };
}

function resolveSuggestionTarget(params: ClickClackCommandSuggestionRequest): string {
  if (params.directConversationId) {
    return buildClickClackTarget({ chatType: "direct", kind: "dm", id: params.senderId });
  }
  return buildClickClackTarget({
    chatType: "group",
    kind: "channel",
    id: params.channelId ?? params.channelName ?? "",
  });
}

function buildSuggestionEntries(params: ClickClackCommandSuggestionRequest): SuggestionEntry[] {
  const entries: SuggestionEntry[] = [];
  let order = 0;
  for (const rawCommand of listChatCommandsForConfig(params.config, {
    skillCommands: params.skillCommands,
  })) {
    const command = rawCommand as CommandWithSuggestionMeta;
    const names = resolveCommandNames(command);
    if (!names.primary) {
      continue;
    }
    entries.push({
      source: command.key.startsWith("skill:") ? "skill" : "core",
      command,
      name: names.primary,
      description: command.description,
      acceptsArgs: command.acceptsArgs ?? false,
      aliases: names.aliases,
      requiresOwner: command.requiresOwner,
      order: order++,
    });
  }
  const pluginCommands: PluginCommandSpec[] =
    params.pluginCommands ?? (listProviderPluginCommandSpecs(CHANNEL_ID) as PluginCommandSpec[]);
  for (const command of pluginCommands) {
    entries.push({
      source: "plugin",
      name: command.name,
      description: command.description,
      acceptsArgs: command.acceptsArgs,
      aliases: [],
      requiresOwner: Boolean(command.requiredScopes?.length),
      order: order++,
    });
  }
  return dedupeEntries(entries);
}

function resolveCommandNames(command: ChatCommandDefinition): {
  primary: string | undefined;
  aliases: string[];
} {
  const rawNames = [
    command.nativeName,
    ...command.textAliases.map(stripSlash),
    ...(command.nativeAliases ?? []),
  ].filter((name): name is string => Boolean(name?.trim()));
  const normalized = new Set<string>();
  const names: string[] = [];
  for (const rawName of rawNames) {
    const name = stripSlash(rawName).trim();
    const key = name.toLowerCase();
    if (!key || normalized.has(key)) {
      continue;
    }
    normalized.add(key);
    names.push(name);
  }
  return {
    primary: names[0],
    aliases: names.slice(1).map((name) => `/${name}`),
  };
}

function dedupeEntries(entries: SuggestionEntry[]): SuggestionEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stripSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function normalizeQueryToken(query: string): string {
  const trimmed = query.trimStart();
  if (!trimmed.startsWith("/")) {
    return "";
  }
  const token = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
  return token.toLowerCase();
}

type MatchInfo = {
  rank: number;
  name: string;
};

function resolveMatch(entry: SuggestionEntry, token: string): MatchInfo | null {
  const names = [entry.name, ...entry.aliases.map(stripSlash)];
  if (!token) {
    return { rank: 2, name: entry.name };
  }
  for (const name of names) {
    if (name.toLowerCase() === token) {
      return { rank: 0, name };
    }
  }
  for (const name of names) {
    if (name.toLowerCase().startsWith(token)) {
      return { rank: 1, name };
    }
  }
  for (const name of names) {
    if (name.toLowerCase().includes(token)) {
      return { rank: 3, name };
    }
  }
  return null;
}

function compareMatches(
  a: { entry: SuggestionEntry; match: MatchInfo },
  b: { entry: SuggestionEntry; match: MatchInfo },
): number {
  return (
    a.match.rank - b.match.rank ||
    sourceWeight(a.entry.source) - sourceWeight(b.entry.source) ||
    tierWeight(a.entry.command?.tier) - tierWeight(b.entry.command?.tier) ||
    a.entry.order - b.entry.order ||
    a.entry.name.localeCompare(b.entry.name)
  );
}

function sourceWeight(source: SuggestionSource): number {
  if (source === "core") {
    return 0;
  }
  if (source === "skill") {
    return 1;
  }
  return 2;
}

function tierWeight(tier: ChatCommandDefinition["tier"]): number {
  if (tier === "essential") {
    return 0;
  }
  if (tier === "power") {
    return 2;
  }
  return 1;
}

function buildSuggestion(params: {
  entry: SuggestionEntry;
  matchedName: string;
  cfg: CoreConfig;
}): ClickClackCommandSuggestion {
  const usage = buildUsage(params.entry);
  return {
    name: `/${params.entry.name}`,
    command: `/${params.entry.name}`,
    insertText: `/${params.matchedName}`,
    description: params.entry.description,
    usage,
    preview: buildPreviewText({
      entry: params.entry,
      usage,
      cfg: params.cfg,
    }),
    source: params.entry.source,
    aliases: params.entry.aliases,
    acceptsArgs: params.entry.acceptsArgs,
    ...(params.entry.requiresOwner ? { requiresOwner: true } : {}),
  };
}

function buildUsage(entry: SuggestionEntry): string {
  if (!entry.acceptsArgs) {
    return `/${entry.name}`;
  }
  if (!entry.command?.args?.length) {
    return `/${entry.name} [args]`;
  }
  return `/${entry.name} ${entry.command.args.map(formatArgUsageToken).join(" ")}`;
}

function formatArgUsageToken(arg: CommandArgDefinition): string {
  const suffix = arg.captureRemaining ? "..." : "";
  return arg.required ? `<${arg.name}${suffix}>` : `[${arg.name}${suffix}]`;
}

function buildPreviewText(params: {
  entry: SuggestionEntry;
  usage: string;
  cfg: CoreConfig;
}): string {
  const lines = [params.usage, params.entry.description];
  const menu = params.entry.command
    ? resolveCommandArgMenu({ command: params.entry.command, cfg: params.cfg })
    : null;
  if (menu?.choices.length) {
    const choices = menu.choices
      .slice(0, 6)
      .map((choice) => choice.label)
      .join(", ");
    const suffix = menu.choices.length > 6 ? ", ..." : "";
    lines.push(`${menu.arg.name}: ${choices}${suffix}`);
  }
  if (params.entry.aliases.length) {
    lines.push(`Aliases: ${params.entry.aliases.join(", ")}`);
  }
  return lines.filter(Boolean).join("\n");
}

function suggestionMatchesExactQuery(
  suggestion: ClickClackCommandSuggestion,
  token: string,
): boolean {
  if (!token) {
    return false;
  }
  const names = [suggestion.name, ...suggestion.aliases].map((name) =>
    stripSlash(name).toLowerCase(),
  );
  return names.includes(token);
}
