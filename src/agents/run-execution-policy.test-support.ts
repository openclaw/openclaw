import { createReplyTurnParticipants } from "../auto-reply/reply/reply-run-registry.tool-authority.js";
import {
  bindGatewayForegroundUserRequest,
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../gateway/local-user-ingress.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { getForegroundUserRequest } from "./foreground-request.js";
import { requireAdmittedRunForeground } from "./run-execution-policy.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  withGatewayPersonalToolUser,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

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

/** Exercise actual participant selection while retaining the original admitted request. */
export async function withForegroundPromotedCaller(
  restriction: "role" | "session",
  run: (selectedProfileId: string) => Promise<void>,
) {
  const original = createAdmittedRunOperatorAuthority({
    profileId: "source",
    scopes: ["operator.write"],
    assertCurrent() {},
    rolePolicy: {
      sessionAccessCap: "none",
      sandboxRequired: true,
      agents: "*",
      ...(restriction === "role" ? { execution: "foreground-only" as const } : {}),
    },
  });
  const broader = createAdmittedRunOperatorAuthority({
    profileId: "maintainer",
    scopes: ["operator.admin"],
    assertCurrent() {},
  });
  const admission = prepareForegroundTestAdmission(`foreground-${restriction}`, original);
  const participants = createReplyTurnParticipants({ operatorAuthority: original });
  participants.accept({ operatorAuthority: broader });
  try {
    const admittedRunContext = await admission.admit("embedded");
    if (restriction === "session") {
      requireAdmittedRunForeground(admittedRunContext);
    }
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext,
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    if (!caller) {
      throw new Error("test caller missing");
    }
    await withGatewayToolCallerIdentity({ ...caller, personalToolParticipants: participants }, () =>
      withGatewayPersonalToolUser(broader.profileId, async () => {
        if (resolveGatewayToolOperatorSelection().operatorAuthority !== broader) {
          throw new Error("test participant was not selected");
        }
        await run(broader.profileId);
      }),
    );
  } finally {
    participants.close();
    await admission.close();
  }
}
