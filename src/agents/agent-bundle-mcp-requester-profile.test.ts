import { expect, it, onTestFinished } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { bindRunRequesterProfile } from "./agent-bundle-mcp-requester-profile.js";

async function admitRunAs(profileId: string) {
  const state = { revoked: false };
  const prepared = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "requester-profile-run",
      agentId: "main",
      ingress: { kind: "system", boundary: "test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("requester-profile-run"),
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId,
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (state.revoked) {
          throw new Error("operator authority revoked");
        }
      },
    }),
  });
  onTestFinished(prepared.close);
  return { prepared, admitted: await prepared.admit("embedded"), state };
}

it("holds a chat turn's profile only while it is the run's live operator authority", async () => {
  const { admitted, state } = await admitRunAs("profile-a");
  expect(bindRunRequesterProfile(undefined, admitted)).toBeUndefined();

  const requester = bindRunRequesterProfile("profile-a", admitted)!;
  expect(requester.profileId).toBe("profile-a");
  expect(() => requester.assertCurrent()).not.toThrow();
  // Another person's profile never rides on this run's authority.
  expect(() => bindRunRequesterProfile("profile-b", admitted)!.assertCurrent()).toThrow(
    "no longer holds this run's operator authority",
  );

  // Revoking the source retires the run's authority, and it stays retired.
  state.revoked = true;
  expect(() => requester.assertCurrent()).toThrow("no longer active");
  state.revoked = false;
  expect(() => requester.assertCurrent()).toThrow("no longer active");
});

it("holds no profile after the run's admission closes", async () => {
  const { prepared, admitted } = await admitRunAs("profile-a");
  const requester = bindRunRequesterProfile("profile-a", admitted)!;
  prepared.close();
  expect(() => requester.assertCurrent()).toThrow("no longer active");
});
