import { resolveReferenceScopedTeamsGetById } from "./sdk-proactive.js";
import type { MSTeamsApp } from "./sdk.js";
import {
  assertMSTeamsSendHandoff,
  withMSTeamsConnectorHandoff,
  type MSTeamsSendHandoff,
} from "./send-handoff.js";

/** Team metadata lookup. Assertion-only so Connector checks run without counting as dispatch. */
export async function lookupReferenceScopedTeamDetails(
  params: {
    app: MSTeamsApp;
    serviceUrl?: string;
    teamId: string;
  } & MSTeamsSendHandoff,
): Promise<{ aadGroupId?: string }> {
  const handoff = { assertDirectAdapterHandoff: params.assertDirectAdapterHandoff };
  return await withMSTeamsConnectorHandoff(handoff, async () => {
    const getById = await resolveReferenceScopedTeamsGetById(params.app, params.serviceUrl);
    assertMSTeamsSendHandoff(handoff);
    if (!getById) {
      throw new Error("Teams team lookup unavailable");
    }
    return await getById(params.teamId);
  });
}
