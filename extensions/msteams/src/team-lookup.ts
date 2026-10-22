import { resolveReferenceScopedTeamsApi } from "./sdk-proactive.js";
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
    const api = resolveReferenceScopedTeamsApi(params.app, params.serviceUrl);
    assertMSTeamsSendHandoff(handoff);
    return await api.teams.getById(params.teamId);
  });
}
