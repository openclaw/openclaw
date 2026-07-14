// Slack plugin module implements per-account event demultiplexing for
// context.ts: resolving the workspace (team) id carried by an inbound Slack
// payload, and building the shouldDropMismatchedSlackEvent filter every
// event surface uses to drop traffic that doesn't belong to this account
// (e.g. when its Bolt App/Socket Mode connection is shared with sibling
// accounts on the same app token).
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

/**
 * Resolves the workspace (team) id carried by an inbound Slack payload,
 * covering every shape the event surfaces treat as a team source: Events API
 * envelopes (`team_id`), interaction bodies (`team.id`), view payloads
 * (`view.team_id`), and shortcut payloads that only identify the user's home
 * workspace (`user.team_id` — see events/interactions.shortcuts.ts). Ordered
 * most-authoritative first; returns "" when no source is present.
 */
export function resolveIncomingSlackEventTeamId(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const raw = body as {
    team_id?: unknown;
    team?: { id?: unknown };
    view?: { team_id?: unknown };
    user?: { team_id?: unknown };
  };
  if (typeof raw.team_id === "string" && raw.team_id) {
    return raw.team_id;
  }
  if (typeof raw.team?.id === "string" && raw.team.id) {
    return raw.team.id;
  }
  if (typeof raw.view?.team_id === "string" && raw.view.team_id) {
    return raw.view.team_id;
  }
  if (typeof raw.user?.team_id === "string" && raw.user.team_id) {
    return raw.user.team_id;
  }
  return "";
}

/**
 * Builds the per-account `shouldDropMismatchedSlackEvent` filter every Slack
 * event surface passes inbound payloads through, to demultiplex traffic when
 * this account's Bolt App/Socket Mode connection may be shared with sibling
 * accounts on the same app token.
 */
export function createSlackShouldDropMismatchedEvent(params: {
  accountId: string;
  accountAbortSignal?: AbortSignal;
  isSharedSocketGroup?: boolean;
  teamId: string;
  apiAppId: string;
}): (body: unknown) => boolean {
  return (body: unknown) => {
    // A stopped account must not keep acting on events. Bolt offers no way to
    // unregister listeners, so when this account was stopped while its (shared
    // or solo) App stays connected, its handlers are still invoked — drop at
    // the gate instead. Universally correct semantics, so no shared/solo split.
    if (params.accountAbortSignal?.aborted) {
      logVerbose(`slack: drop event for stopped account ${params.accountId}`);
      return true;
    }
    // On a shared App an account without a resolved teamId (boot auth.test
    // failed) has no way to demux its own workspace's traffic from its
    // siblings'. Processing anyway would act on OTHER tenants' events, so
    // fail closed until restart with a valid bot token. Solo accounts keep
    // the historical lenient behavior below.
    if (params.isSharedSocketGroup && !params.teamId) {
      logVerbose(
        `slack: drop event for account ${params.accountId} (teamId unresolved on shared socket group)`,
      );
      return true;
    }
    const raw =
      body && typeof body === "object"
        ? (body as {
            api_app_id?: unknown;
          })
        : undefined;
    const incomingApiAppId = typeof raw?.api_app_id === "string" ? raw.api_app_id : "";
    const incomingTeamId = raw ? resolveIncomingSlackEventTeamId(raw) : "";

    if (params.apiAppId && incomingApiAppId && incomingApiAppId !== params.apiAppId) {
      logVerbose(
        `slack: drop event with api_app_id=${incomingApiAppId} (expected ${params.apiAppId})`,
      );
      return true;
    }
    if (params.teamId && incomingTeamId && incomingTeamId !== params.teamId) {
      logVerbose(`slack: drop event with team_id=${incomingTeamId} (expected ${params.teamId})`);
      return true;
    }
    // On a shared App, api_app_id is identical for every account, so team is
    // the ONLY demux key. A payload without any team information would sail
    // through every sharing account's filter and be processed by all of them
    // (cross-tenant processing) — fail closed instead. Solo accounts keep the
    // historical lenient pass-through for team-less payloads.
    if (params.isSharedSocketGroup && !incomingTeamId) {
      logVerbose(
        `slack: drop event without team info for account ${params.accountId} (shared socket group)`,
      );
      return true;
    }
    return false;
  };
}
