import type { OpenClawConfig } from "../../../../src/config/config.js";
import { listBoundAccountIds } from "../../../../src/routing/bindings.js";
import {
  resolveAgentRoute,
  type ResolveAgentRouteInput,
  type ResolvedAgentRoute,
} from "../../../../src/routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../../src/routing/session-key.js";
import { listDiscordAccountIds } from "../accounts.js";

const ROUTE_PRIORITY: Record<ResolvedAgentRoute["matchedBy"], number> = {
  "binding.peer": 0,
  "binding.peer.parent": 1,
  "binding.guild+roles": 2,
  "binding.guild": 3,
  "binding.team": 4,
  "binding.account": 5,
  "binding.channel": 6,
  default: 7,
};

export type DiscordRouteOwner = {
  accountId: string;
  route: ResolvedAgentRoute;
};

type DiscordRouteOwnerInput = Pick<
  ResolveAgentRouteInput,
  "cfg" | "guildId" | "memberRoleIds" | "peer" | "parentPeer"
> & {
  currentAccountId?: string | null;
  currentRoute: ResolvedAgentRoute;
};

function listDiscordCandidateAccountIds(cfg: OpenClawConfig): string[] {
  return Array.from(
    new Set([
      DEFAULT_ACCOUNT_ID,
      ...listDiscordAccountIds(cfg),
      ...listBoundAccountIds(cfg, "discord"),
    ]),
  )
    .map((accountId) => normalizeAccountId(accountId))
    .filter(Boolean);
}

export function resolveDiscordRouteOwner(params: DiscordRouteOwnerInput): DiscordRouteOwner | null {
  const currentAccountId = normalizeAccountId(params.currentAccountId);
  const currentPriority = ROUTE_PRIORITY[params.currentRoute.matchedBy];
  let owner: { accountId: string; route: ResolvedAgentRoute; priority: number } | null = null;

  for (const accountId of listDiscordCandidateAccountIds(params.cfg)) {
    if (accountId === currentAccountId) {
      continue;
    }
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      accountId,
      guildId: params.guildId ?? undefined,
      memberRoleIds: params.memberRoleIds,
      peer: params.peer,
      parentPeer: params.parentPeer ?? undefined,
    });
    const priority = ROUTE_PRIORITY[route.matchedBy];
    if (priority >= currentPriority) {
      continue;
    }
    if (!owner || priority < owner.priority) {
      owner = { accountId, route, priority };
    }
  }

  return owner ? { accountId: owner.accountId, route: owner.route } : null;
}
