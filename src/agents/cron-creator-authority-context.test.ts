import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  consumeCronCreatorAuthorityGrant,
  mintCronCreatorAuthorityGrant,
  resolveCronCreatorAuthorityGrantProvenance,
  revokeCronCreatorAuthorityRunScope,
} from "../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  bindActiveOperatorTurnAuthority,
  bindActiveCronAuthorityCurrentness,
  bindActiveCronCreatorAuthorityResolver,
  bindCronManagementGrant,
  bindCronRequesterGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapabilityResolver,
} from "./cron-creator-authority-context.js";
import { createCronTool } from "./tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

function admittedFixture(
  runId: string,
  kind: "local" | "unknown" = "unknown",
  source: "control-ui-admin" | "channel-owner" = "control-ui-admin",
  callerScopedCreation?: true,
) {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  onTestFinished(() => {
    releaseAgentRunDelegatedAuthority(authority);
  });
  const scope = createCronCreatorAuthorityCapability(
    runId,
    { kind },
    source === "channel-owner" ? { source, isCurrent: () => true } : { source },
    undefined,
    undefined,
    undefined,
    callerScopedCreation,
  );
  if (!scope) {
    throw new Error("expected capability");
  }
  const caller = {
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    approvalAuthority: authority,
  };
  return {
    authority,
    scope,
    caller,
    run: <T>(run: () => T) =>
      runWithCronCreatorAuthorityCapability(scope, () =>
        withGatewayToolCallerIdentity(caller, run),
      ),
  };
}

describe("creator caller currentness", () => {
  it("retains the original caller predicate and rejects resolver use after revocation", async () => {
    let current = true;
    const capability = createCronCreatorAuthorityCapability(
      "native-creator",
      { kind: "local" },
      undefined,
      () => current,
    )!;
    const resolve = vi.fn(async () => ({
      tools: ["message"],
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
    }));
    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveCronAuthorityCurrentness("other-run")).toBeUndefined();
      const captured = bindActiveCronAuthorityCurrentness(capability.runId);
      const resolver = runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId: capability.runId,
        resolve,
        run: () => bindActiveCronCreatorAuthorityResolver(capability.runId),
      });
      current = false;
      expect(captured?.()).toBe(false);
      await expect(resolver!()).rejects.toThrow("Automation caller authority is no longer active");
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("binds an explicit exact-run origin and expires retained operator authority", async () => {
    const capability = createCronCreatorAuthorityCapability("owner-run", {
      kind: "external",
      channel: "discord",
    });
    if (!capability) {
      throw new Error("expected capability");
    }
    let retained: ReturnType<typeof bindActiveOperatorTurnAuthority>;
    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveOperatorTurnAuthority("other-run")).toBeUndefined();
      retained = bindActiveOperatorTurnAuthority("owner-run");
      expect(retained?.source).toBe("channel-owner");
      expect(() => retained?.assertActive()).not.toThrow();
    });
    expect(() => retained?.assertActive()).toThrow();
  });
});

describe("Cron grant admission", () => {
  it.each([
    ["local", "control-ui-admin", undefined],
    ["unknown", "control-ui-admin", undefined],
    ["unknown", "channel-owner", undefined],
    ["unknown", "control-ui-admin", true],
  ] as const)(
    "separates management, creation, and runtime authority for %s/%s (fresh=%s)",
    async (kind, source, callerScopedCreation) => {
      const runId = "control-ui-scope-run";
      const { scope, authority, run } = admittedFixture(runId, kind, source, callerScopedCreation);
      const resolve = vi.fn(async () => ({
        tools: ["read"],
        provenance: { version: 1 as const, source: "final-executable-surface" as const },
      }));
      await run(async () => {
        expect(
          withoutGatewayToolCallerIdentity(() => bindCronManagementGrant(runId)),
        ).toBeUndefined();
        const management = bindCronManagementGrant(runId)!;
        expect(management.managementOnly).toBe(kind === "unknown" && !callerScopedCreation);
        for (const method of ["cron.list", "cron.get", "cron.update", "cron.run", "cron.remove"]) {
          expect(management.mint(method)).toMatchObject({ runId, token: expect.any(String) });
        }
        const operator = bindActiveOperatorTurnAuthority(runId);
        const creator = runWithCronCreatorAuthorityCapabilityResolver({
          capability: scope,
          runId,
          resolve,
          run: () => bindActiveCronCreatorAuthorityResolver(runId),
        });
        if (kind === "local") {
          expect(operator?.source).toBe("local");
          await expect(creator!()).resolves.toMatchObject({ tools: ["read"] });
        } else {
          expect(operator).toBeUndefined();
          expect(creator).toBeUndefined();
          expect(resolve).not.toHaveBeenCalled();
          expect(() => mintCronCreatorAuthorityGrant(scope)).toThrow(
            "Automation creation is not granted",
          );
        }
        for (const method of ["cron.add", "cron.status", "cron.runs", "wake"]) {
          if (kind === "local" || callerScopedCreation) {
            expect(management.mint(method)).toBeUndefined();
          } else {
            expect(() => management.mint(method)).toThrow(
              "Use the Automations page for other actions",
            );
          }
        }
        const requester = bindCronRequesterGrant(runId);
        if (kind === "unknown" && !callerScopedCreation) {
          expect(requester).toBeUndefined();
          expect(() => management.mint("cron.add")).toThrow("management-only");
        } else if (callerScopedCreation) {
          const grant = requester!();
          expect(resolveCronCreatorAuthorityGrantProvenance(grant, runId)).toEqual({
            capturesRuntimeAuthority: false,
          });
          expect(consumeCronCreatorAuthorityGrant(grant).authority).toBeUndefined();
          expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
          const pending = requester!();
          revokeCronCreatorAuthorityRunScope(scope);
          expect(() => consumeCronCreatorAuthorityGrant(pending)).toThrow("no longer active");
          expect(() => requester!()).toThrow("no longer active");
        }
        releaseAgentRunDelegatedAuthority(authority);
        expect(bindCronManagementGrant(runId)).toBeUndefined();
      });
    },
  );

  it("does not transfer an admin tool's authority to a replacement with the same run id", async () => {
    const runId = "control-ui-admin-run";
    const { caller, run } = admittedFixture(runId, "local");
    await run(async () => {
      const mint = bindCronManagementGrant(runId)?.mint;
      expect(mint).toBeTypeOf("function");
      expect(() => mint!("cron.get")).not.toThrow();
      const replacement = createTestAdmittedRunContext(runId).operationalRunInstance;
      const replacementAuthority = claimAgentRunDelegatedAuthority(replacement);
      onTestFinished(() => {
        releaseAgentRunDelegatedAuthority(replacementAuthority);
      });
      await withGatewayToolCallerIdentity(
        { ...caller, operationalRunInstance: replacement, approvalAuthority: replacementAuthority },
        async () => {
          expect(getGatewayToolCallerIdentity()?.approvalAuthority).toBe(replacementAuthority);
          expect(() => mint!("cron.get")).toThrow(
            "Retry from a fresh authenticated configured channel owner or Control UI administrator turn",
          );
        },
      );
    });
  });

  it("exposes add but refuses incomplete capture and retired requester authority", async () => {
    const runId = "remote-admin-capture";
    const { authority, caller, run } = admittedFixture(runId, "unknown", "control-ui-admin", true);
    caller.sessionKey = "agent:main:remote";
    await run(async () => {
      const callGatewayTool = vi.fn();
      const tool = createCronTool(
        {
          runId,
          agentSessionKey: caller.sessionKey,
          creatorToolAllowlist: ["read"],
          creatorToolAllowlistCaptureRef: {},
        },
        { callGatewayTool },
      );
      expect(tool.parameters).toHaveProperty(
        "properties.action.enum",
        expect.arrayContaining(["add", "list", "update"]),
      );
      await expect(
        tool.execute("incomplete", {
          action: "add",
          job: {
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { kind: "agentTurn", message: "Read status" },
          },
        }),
      ).rejects.toThrow("did not capture the complete model-callable tool surface");
      expect(callGatewayTool).not.toHaveBeenCalled();
      const requester = bindCronRequesterGrant(runId)!;
      const grant = requester();
      releaseAgentRunDelegatedAuthority(authority);
      expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
      expect(() => requester()).toThrow("no longer active");
    });
  });
});
