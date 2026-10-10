import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveZalouserAccountSync } from "./accounts.js";
import { parseZalouserDirectoryGroupId } from "./session-route.js";
import type { ZcaFriend } from "./types.js";
import type { listZaloGroupMembers } from "./zalo-js.js";

type ZalouserDirectoryDeps = {
  listZaloGroupMembers: typeof listZaloGroupMembers;
};

export function mapZalouserDirectoryUser(user: ZcaFriend): ChannelDirectoryEntry {
  return {
    kind: "user",
    id: user.userId,
    name: user.displayName ?? undefined,
    avatarUrl: user.avatar ?? undefined,
    raw: user,
  };
}

export async function listZalouserDirectoryGroupMembers(
  params: {
    cfg: OpenClawConfig;
    accountId?: string;
    groupId: string;
    limit?: number;
  },
  deps: ZalouserDirectoryDeps,
) {
  const account = resolveZalouserAccountSync({ cfg: params.cfg, accountId: params.accountId });
  const normalizedGroupId = parseZalouserDirectoryGroupId(params.groupId);
  const members = await deps.listZaloGroupMembers(account.profile, normalizedGroupId);
  const rows = members.map(mapZalouserDirectoryUser);
  return typeof params.limit === "number" && params.limit > 0 ? rows.slice(0, params.limit) : rows;
}
