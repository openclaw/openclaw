import {
  bindGatewayForegroundUserRequest,
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../gateway/local-user-ingress.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { getForegroundUserRequest } from "./foreground-request.js";

export function prepareForegroundTestAdmission(
  runId: string,
  operatorAuthority?: AdmittedRunOperatorAuthority,
) {
  const client = {};
  attachGatewayLocalUserIngress(
    client,
    prepareGatewayLocalUserIngress({
      authMethod: "token",
      authenticatedUserExpected: true,
      isLocalClient: false,
      profile: { profileId: operatorAuthority?.profileId ?? "maintainer" },
    }),
  );
  const input = {};
  bindGatewayForegroundUserRequest(client, input, () => {});
  return prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    operatorAuthority,
    foregroundRequest: getForegroundUserRequest(input),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "gateway-client", boundary: "test", state: "present" },
    },
  });
}
