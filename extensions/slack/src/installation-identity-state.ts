// Slack plugin module owns authenticated installation identity state.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

type SlackInstallationKind = "workspace" | "enterprise" | "degraded";

type SlackInstallationStateEntry = {
  kind: SlackInstallationKind;
  teamId?: string;
  owner: symbol;
};

type SlackInstallationStateRegistration = {
  update: (kind: SlackInstallationKind, teamId?: string) => void;
  release: () => void;
};

const slackInstallationStates = resolveGlobalMap<string, SlackInstallationStateEntry>(
  Symbol.for("openclaw.slack.installation-identities"),
  "close-and-restart",
);

export function registerSlackInstallationState(
  accountId: string,
  kind: SlackInstallationKind,
  teamId?: string,
): SlackInstallationStateRegistration {
  const normalizedAccountId = normalizeAccountId(accountId);
  const owner = Symbol(`slack-installation:${normalizedAccountId}`);
  slackInstallationStates.set(normalizedAccountId, { kind, teamId, owner });
  return {
    update: (nextKind, nextTeamId) => {
      if (slackInstallationStates.get(normalizedAccountId)?.owner === owner) {
        slackInstallationStates.set(normalizedAccountId, {
          kind: nextKind,
          teamId: nextTeamId,
          owner,
        });
      }
    },
    release: () => {
      if (slackInstallationStates.get(normalizedAccountId)?.owner === owner) {
        slackInstallationStates.delete(normalizedAccountId);
      }
    },
  };
}

export function getSlackInstallationKind(accountId: string): SlackInstallationKind | undefined {
  return slackInstallationStates.get(normalizeAccountId(accountId))?.kind;
}

export function getSlackInstallationTeamId(accountId: string): string | undefined {
  const state = slackInstallationStates.get(normalizeAccountId(accountId));
  return state?.kind === "workspace" ? state.teamId : undefined;
}

export function isSlackWorkspaceInstallation(accountId: string): boolean {
  return getSlackInstallationKind(accountId) === "workspace";
}
