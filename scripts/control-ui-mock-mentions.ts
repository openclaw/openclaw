import type {
  MentionableUser,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../packages/gateway-protocol/src/schema/human-mentions.js";
import type { SessionParticipant } from "../packages/gateway-protocol/src/schema/session-participant.js";
import type {
  ControlUiMockGateway,
  ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

// Serialized into the page. This projects the existing profile-capable fixture;
// private/draft authorization and unknown sessions are deliberately not simulated.
function installMentionMock(
  profileId: string | null,
  sessionKeys: string[],
  users: MentionableUser[],
): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mention fixtures require the mock Gateway");
  }
  gateway.setRequestHandler("users.mentionable", ({ params, respond }) => {
    const input = params as UsersMentionableParams;
    if (!profileId) {
      respond({
        __mockError: { code: "FORBIDDEN", message: "This fixture has no verified reader profile." },
      });
      return;
    }
    if (!("sessionKey" in input)) {
      respond({
        __mockError: { code: "UNAVAILABLE", message: "Draft mention fixtures are unavailable." },
      });
      return;
    }
    if (!sessionKeys.includes(input.sessionKey)) {
      respond({ __mockError: { code: "INVALID_REQUEST", message: "Session was not found." } });
      return;
    }
    const row = gateway.getSessionRow(input.sessionKey);
    if (input.agentId && input.agentId !== (row.agentId ?? row.key.split(":")[1])) {
      respond({
        __mockError: { code: "INVALID_REQUEST", message: "Session agent does not match." },
      });
      return;
    }
    if ((row.visibility ?? "shared") !== "shared") {
      respond({
        __mockError: { code: "UNAVAILABLE", message: "Private mention fixtures are unavailable." },
      });
      return;
    }
    // Native directory matching trims and folds display names and verified logins.
    // These existing participants have names but no verified login fixture data.
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    respond({
      users:
        row.incognito === true
          ? []
          : users.filter(
              (user) =>
                user.profileId !== profileId &&
                (!query || user.displayName.toLocaleLowerCase().includes(query)),
            ),
      truncated: false,
    } satisfies UsersMentionableResult);
  });
}

export function mentionMockInitScript(
  scenario: ControlUiMockGatewayScenario,
  participants: readonly SessionParticipant[],
): string {
  const viewer = scenario.presenceUsers?.find((user) => user.self)?.identity;
  const canRead =
    !scenario.operatorScopes ||
    scenario.operatorScopes.some(
      (scope) => scope === "operator.read" || scope === "operator.admin",
    );
  const profileId = canRead && viewer?.type === "profile" ? viewer.id : null;
  const users = participants.flatMap((person): MentionableUser[] =>
    person.identity.type === "profile" && person.label
      ? [{ profileId: person.identity.id, displayName: person.label, online: false }]
      : [],
  );
  users.sort((left, right) => left.displayName.localeCompare(right.displayName));
  return `(() => { const __name = (target) => target; (${installMentionMock.toString()})(${JSON.stringify(profileId)}, ${JSON.stringify(scenario.sessions?.map((row) => row.key) ?? [])}, ${JSON.stringify(users)}); })();`;
}
