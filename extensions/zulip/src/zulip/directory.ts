import type { ChannelDirectoryEntry, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  fetchZulipMe,
  fetchZulipStreams,
  fetchZulipUsers,
  type ZulipClient,
} from "./client.js";

export type ZulipDirectoryParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime: RuntimeEnv;
};

function buildClient(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ZulipClient | null {
  const account = resolveZulipAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled || !account.botEmail || !account.botApiKey || !account.baseUrl) {
    return null;
  }
  return createZulipClient({
    baseUrl: account.baseUrl,
    botEmail: account.botEmail,
    botApiKey: account.botApiKey,
  });
}

function matchesQuery(values: string[], query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return values.some((value) => value.toLowerCase().includes(normalized));
}

export async function listZulipDirectoryPeers(
  params: ZulipDirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = buildClient(params);
  if (!client) {
    return [];
  }
  try {
    const [me, users] = await Promise.all([fetchZulipMe(client), fetchZulipUsers(client)]);
    const entries = users
      .filter((user) => user.user_id !== me.user_id)
      .filter((user) =>
        matchesQuery(
          [
            user.full_name,
            user.email,
            user.email.includes("@") ? user.email.slice(0, user.email.indexOf("@")) : user.email,
          ],
          params.query ?? "",
        ),
      )
      .map((user) => ({
        kind: "user" as const,
        id: `dm:${user.user_id}`,
        name: user.full_name || undefined,
        handle: user.email || undefined,
      }));
    return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
  } catch (err) {
    params.runtime.log?.(
      `[zulip-directory] listPeers failed: ${(err as Error)?.message ?? String(err)}`,
    );
    return [];
  }
}

export async function listZulipDirectoryGroups(
  params: ZulipDirectoryParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = buildClient(params);
  if (!client) {
    return [];
  }
  try {
    const streams = await fetchZulipStreams(client);
    const entries = streams
      .filter((stream) => matchesQuery([stream.name, stream.description ?? ""], params.query ?? ""))
      .map((stream) => ({
        kind: "group" as const,
        id: `stream:${stream.name}`,
        name: stream.name || undefined,
        handle: stream.description || undefined,
      }));
    return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
  } catch (err) {
    params.runtime.log?.(
      `[zulip-directory] listGroups failed: ${(err as Error)?.message ?? String(err)}`,
    );
    return [];
  }
}
