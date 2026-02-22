import type {
  ChannelDirectoryEntry,
  ChannelResolveResult,
  OpenClawConfig,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveSimplexAccount } from "./accounts.js";
import {
  buildListContactsCommand,
  buildListGroupMembersCommand,
  buildListGroupsCommand,
  buildShowActiveUserCommand,
} from "./simplex-commands.js";
import { SimplexWsClient } from "./simplex-ws-client.js";
import type { ResolvedSimplexAccount } from "./types.js";

type SimplexDirectoryParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  runtime: RuntimeEnv;
};

type ActiveUserInfo = {
  userId?: string;
  displayName?: string;
  raw?: unknown;
};

function toId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function normalizeQuery(query?: string | null): string {
  return (query ?? "").trim().toLowerCase();
}

function mapContactEntry(entry: unknown): ChannelDirectoryEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const contact = (record.contact as Record<string, unknown> | undefined) ?? record;
  const id = toId(contact.contactId ?? contact.id ?? record.contactId ?? record.id);
  if (!id) {
    return null;
  }
  const profile = (contact.profile as Record<string, unknown> | undefined) ?? {};
  const name =
    toId(contact.localDisplayName) ??
    toId(profile.displayName) ??
    toId(profile.fullName) ??
    toId(record.localDisplayName) ??
    undefined;
  return {
    kind: "user",
    id,
    name,
    raw: entry,
  };
}

function mapGroupEntry(entry: unknown): ChannelDirectoryEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const group =
    (record.groupInfo as Record<string, unknown> | undefined) ??
    (record.group as Record<string, unknown> | undefined) ??
    record;
  const id = toId(group.groupId ?? group.id ?? record.groupId ?? record.id);
  if (!id) {
    return null;
  }
  const profile =
    (group.groupProfile as Record<string, unknown> | undefined) ??
    (group.profile as Record<string, unknown> | undefined) ??
    {};
  const name =
    toId(group.localDisplayName) ??
    toId(profile.displayName) ??
    toId(profile.fullName) ??
    toId(record.localDisplayName) ??
    undefined;
  return {
    kind: "group",
    id,
    name,
    raw: entry,
  };
}

function mapMemberEntry(entry: unknown): ChannelDirectoryEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const member = (record.groupMember as Record<string, unknown> | undefined) ?? record;
  const id = toId(
    member.groupMemberId ??
      member.memberId ??
      member.contactId ??
      record.groupMemberId ??
      record.memberId,
  );
  if (!id) {
    return null;
  }
  const profile = (member.profile as Record<string, unknown> | undefined) ?? {};
  const name =
    toId(member.localDisplayName) ??
    toId(profile.displayName) ??
    toId(profile.fullName) ??
    undefined;
  return {
    kind: "user",
    id,
    name,
    raw: entry,
  };
}

function normalizeSimplexInputId(input: string): { id: string; explicit: boolean } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { id: "", explicit: false };
  }
  const withoutPrefix = trimmed.toLowerCase().startsWith("simplex:")
    ? trimmed.slice("simplex:".length).trim()
    : trimmed;
  const lowered = withoutPrefix.toLowerCase();
  if (lowered.startsWith("#")) {
    return { id: withoutPrefix.slice(1).trim(), explicit: true };
  }
  if (lowered.startsWith("@")) {
    return { id: withoutPrefix.slice(1).trim(), explicit: true };
  }
  if (lowered.startsWith("group:")) {
    return { id: withoutPrefix.slice("group:".length).trim(), explicit: true };
  }
  if (
    lowered.startsWith("contact:") ||
    lowered.startsWith("user:") ||
    lowered.startsWith("member:")
  ) {
    return { id: withoutPrefix.slice(withoutPrefix.indexOf(":") + 1).trim(), explicit: true };
  }
  return { id: withoutPrefix, explicit: false };
}

async function withSimplexClient<T>(
  account: ResolvedSimplexAccount,
  fn: (client: SimplexWsClient) => Promise<T>,
): Promise<T> {
  const client = new SimplexWsClient({
    url: account.wsUrl,
    connectTimeoutMs: account.config.connection?.connectTimeoutMs,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function fetchActiveUserInfo(
  account: ResolvedSimplexAccount,
  runtime: RuntimeEnv,
): Promise<ActiveUserInfo | null> {
  try {
    return await withSimplexClient(account, async (client) => {
      const response = await client.sendCommand(buildShowActiveUserCommand());
      const resp = response.resp as Record<string, unknown> | undefined;
      const user =
        (resp?.user as Record<string, unknown> | undefined) ??
        (resp?.activeUser as Record<string, unknown> | undefined) ??
        (resp?.profile as Record<string, unknown> | undefined) ??
        (resp?.userProfile as Record<string, unknown> | undefined) ??
        resp;
      if (!user || typeof user !== "object") {
        return null;
      }
      const profile = (user.profile as Record<string, unknown> | undefined) ?? {};
      const userId = toId(user.userId ?? user.id ?? profile.userId);
      const displayName =
        toId(profile.displayName) ?? toId(profile.fullName) ?? toId(user.displayName);
      return { userId, displayName, raw: user };
    });
  } catch (err) {
    runtime.error?.(`simplex: failed to read active user: ${String(err)}`);
    return null;
  }
}

async function listContactsLive(params: {
  account: ResolvedSimplexAccount;
  runtime: RuntimeEnv;
  query?: string | null;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  const activeUser = await fetchActiveUserInfo(params.account, params.runtime);
  const activeUserId = activeUser?.userId;
  if (!activeUserId) {
    return [];
  }
  return await withSimplexClient(params.account, async (client) => {
    const response = await client.sendCommand(buildListContactsCommand(activeUserId));
    const resp = response.resp as Record<string, unknown> | undefined;
    const contacts =
      (resp?.contacts as unknown[]) ??
      (resp?.contactList as unknown[]) ??
      (resp?.contactsList as unknown[]) ??
      (resp?.items as unknown[]) ??
      [];
    const mapped = contacts.map(mapContactEntry).filter(Boolean) as ChannelDirectoryEntry[];
    const q = normalizeQuery(params.query);
    const filtered = q
      ? mapped.filter(
          (entry) =>
            entry.id.toLowerCase().includes(q) || (entry.name?.toLowerCase().includes(q) ?? false),
        )
      : mapped;
    const limit = params.limit && params.limit > 0 ? params.limit : undefined;
    return limit ? filtered.slice(0, limit) : filtered;
  });
}

async function listGroupsLive(params: {
  account: ResolvedSimplexAccount;
  runtime: RuntimeEnv;
  query?: string | null;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  const activeUser = await fetchActiveUserInfo(params.account, params.runtime);
  const activeUserId = activeUser?.userId;
  if (!activeUserId) {
    return [];
  }
  return await withSimplexClient(params.account, async (client) => {
    const response = await client.sendCommand(
      buildListGroupsCommand({
        userId: activeUserId,
        search: params.query ?? undefined,
      }),
    );
    const resp = response.resp as Record<string, unknown> | undefined;
    const groups =
      (resp?.groups as unknown[]) ??
      (resp?.groupList as unknown[]) ??
      (resp?.groupsList as unknown[]) ??
      (resp?.items as unknown[]) ??
      [];
    const mapped = groups.map(mapGroupEntry).filter(Boolean) as ChannelDirectoryEntry[];
    const q = normalizeQuery(params.query);
    const filtered = q
      ? mapped.filter(
          (entry) =>
            entry.id.toLowerCase().includes(q) || (entry.name?.toLowerCase().includes(q) ?? false),
        )
      : mapped;
    const limit = params.limit && params.limit > 0 ? params.limit : undefined;
    return limit ? filtered.slice(0, limit) : filtered;
  });
}

async function listGroupMembersLive(params: {
  account: ResolvedSimplexAccount;
  runtime: RuntimeEnv;
  groupId: string;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  return await withSimplexClient(params.account, async (client) => {
    const response = await client.sendCommand(
      buildListGroupMembersCommand({
        groupId: params.groupId,
      }),
    );
    const resp = response.resp as Record<string, unknown> | undefined;
    const members =
      (resp?.members as unknown[]) ??
      (resp?.groupMembers as unknown[]) ??
      (resp?.items as unknown[]) ??
      (resp?.group as Record<string, unknown> | undefined)?.members ??
      [];
    const mapped = (Array.isArray(members) ? members : [])
      .map(mapMemberEntry)
      .filter(Boolean) as ChannelDirectoryEntry[];
    const limit = params.limit && params.limit > 0 ? params.limit : undefined;
    return limit ? mapped.slice(0, limit) : mapped;
  });
}

export async function resolveSimplexSelf(
  params: SimplexDirectoryParams,
): Promise<ChannelDirectoryEntry | null> {
  const account = resolveSimplexAccount(params);
  if (!account.configured) {
    return null;
  }
  const activeUser = await fetchActiveUserInfo(account, params.runtime);
  if (!activeUser?.userId) {
    return null;
  }
  return {
    kind: "user",
    id: activeUser.userId,
    name: activeUser.displayName,
    raw: activeUser.raw,
  };
}

export async function listSimplexDirectoryPeers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime: RuntimeEnv;
}): Promise<ChannelDirectoryEntry[]> {
  const account = resolveSimplexAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return [];
  }
  return await listContactsLive({
    account,
    runtime: params.runtime,
    query: params.query,
    limit: params.limit,
  });
}

export async function listSimplexDirectoryGroups(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime: RuntimeEnv;
}): Promise<ChannelDirectoryEntry[]> {
  const account = resolveSimplexAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return [];
  }
  return await listGroupsLive({
    account,
    runtime: params.runtime,
    query: params.query,
    limit: params.limit,
  });
}

export async function listSimplexGroupMembers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId: string;
  limit?: number | null;
  runtime: RuntimeEnv;
}): Promise<ChannelDirectoryEntry[]> {
  const account = resolveSimplexAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return [];
  }
  return await listGroupMembersLive({
    account,
    runtime: params.runtime,
    groupId: params.groupId,
    limit: params.limit,
  });
}

export async function resolveSimplexTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: "user" | "group";
  runtime: RuntimeEnv;
}): Promise<ChannelResolveResult[]> {
  const account = resolveSimplexAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    return params.inputs.map((input) => ({
      input,
      resolved: false,
      note: "simplex account not configured",
    }));
  }
  const entries =
    params.kind === "group"
      ? await listGroupsLive({ account, runtime: params.runtime })
      : await listContactsLive({ account, runtime: params.runtime });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return params.inputs.map((input) => {
    const { id, explicit } = normalizeSimplexInputId(input);
    if (explicit && id) {
      const match = byId.get(id);
      return {
        input,
        resolved: true,
        id,
        name: match?.name,
        note: match ? undefined : "treated as explicit id",
      };
    }
    if (id && byId.has(id)) {
      const match = byId.get(id);
      return {
        input,
        resolved: true,
        id,
        name: match?.name,
      };
    }
    const needle = normalizeQuery(input);
    if (!needle) {
      return { input, resolved: false };
    }
    const matches = entries.filter((entry) => (entry.name ?? "").toLowerCase().includes(needle));
    if (matches.length === 1) {
      return {
        input,
        resolved: true,
        id: matches[0].id,
        name: matches[0].name,
      };
    }
    if (matches.length > 1) {
      return {
        input,
        resolved: false,
        note: `multiple matches (${matches.length})`,
      };
    }
    return {
      input,
      resolved: false,
      note: "not found",
    };
  });
}
