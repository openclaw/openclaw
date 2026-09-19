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

describe("creator caller currentness", () => {
  it("retains the original caller predicate for native tool captures", async () => {
    let current = true;
    const isCurrent = () => current;
    const capability = createCronCreatorAuthorityCapability(
      "native-creator",
      { kind: "local" },
      undefined,
      isCurrent,
    )!;
    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveCronAuthorityCurrentness("other-run")).toBeUndefined();
      const captured = bindActiveCronAuthorityCurrentness("native-creator");
      current = false;
      expect(captured?.()).toBe(false);
    });
  });

  it("refuses new tool-surface resolution after the original caller is revoked", async () => {
    let current = true;
    const capability = createCronCreatorAuthorityCapability(
      "revoked-creator",
      { kind: "local" },
      undefined,
      () => current,
    )!;
    const resolve = vi.fn(async () => ({
      tools: ["message"],
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
    }));
    await runWithCronCreatorAuthorityCapability(capability, async () => {
      const resolver = runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId: capability.runId,
        resolve,
        run: () => bindActiveCronCreatorAuthorityResolver(capability.runId),
      });
      current = false;
      await expect(resolver!()).rejects.toThrow("Automation caller authority is no longer active");
      expect(resolve).not.toHaveBeenCalled();
    });
  });
});

describe("bindActiveOperatorTurnAuthority", () => {
  it("binds an explicit exact-run origin and expires retained authority", async () => {
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

  it("does not promote an unknown active origin", async () => {
    const capability = createCronCreatorAuthorityCapability("unknown-run");
    if (!capability) {
      throw new Error("expected capability");
    }

    await runWithCronCreatorAuthorityCapability(capability, async () => {
      expect(bindActiveOperatorTurnAuthority("unknown-run")).toBeUndefined();
    });
  });
});

describe("bindCronManagementGrant", () => {
  it.each([
    ["local", "control-ui-admin"],
    ["unknown", "control-ui-admin"],
    ["unknown", "channel-owner"],
  ] as const)(
    "keeps %s management admission from %s within its original creator and operator authority",
    async (kind, source) => {
      const runId = "control-ui-scope-run";
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      onTestFinished(() => {
        releaseAgentRunDelegatedAuthority(authority);
      });
      const capability = createCronCreatorAuthorityCapability(
        runId,
        { kind },
        source === "channel-owner" ? { source, isCurrent: () => true } : { source },
      )!;
      const resolveCreator = vi.fn(async () => ({
        tools: ["read"],
        provenance: { version: 1 as const, source: "final-executable-surface" as const },
      }));
      await runWithCronCreatorAuthorityCapability(capability, () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:control-ui",
            operationalRunInstance,
            approvalAuthority: authority,
          },
          async () => {
            expect(
              withoutGatewayToolCallerIdentity(() => bindCronManagementGrant(runId)),
            ).toBeUndefined();
            const management = bindCronManagementGrant(runId)!;
            expect(management.managementOnly).toBe(kind === "unknown");
            const mint = management.mint;
            for (const method of [
              "cron.list",
              "cron.get",
              "cron.update",
              "cron.run",
              "cron.remove",
            ]) {
              expect(mint(method)).toMatchObject({ runId, token: expect.any(String) });
            }
            const operator = bindActiveOperatorTurnAuthority(runId);
            const creator = runWithCronCreatorAuthorityCapabilityResolver({
              capability,
              runId,
              resolve: resolveCreator,
              run: () => bindActiveCronCreatorAuthorityResolver(runId),
            });
            if (kind === "local") {
              expect(operator?.source).toBe("local");
              await expect(creator!()).resolves.toMatchObject({ tools: ["read"] });
            } else {
              expect(operator).toBeUndefined();
              expect(creator).toBeUndefined();
              expect(resolveCreator).not.toHaveBeenCalled();
              expect(() => mintCronCreatorAuthorityGrant(capability)).toThrow(
                "Automation creation is not granted",
              );
            }
            for (const method of ["cron.add", "cron.status", "cron.runs", "wake"]) {
              if (kind === "local") {
                expect(mint(method)).toBeUndefined();
              } else {
                expect(() => mint(method)).toThrow("Use the Automations page for other actions");
              }
            }
            releaseAgentRunDelegatedAuthority(authority);
            expect(bindCronManagementGrant(runId)).toBeUndefined();
          },
        ),
      );
    },
  );

  it("does not transfer an admin tool's authority to a replacement with the same run id", async () => {
    const runId = "control-ui-admin-run";
    const { operationalRunInstance } = createTestAdmittedRunContext(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(authority);
    });
    const capability = createCronCreatorAuthorityCapability(
      runId,
      { kind: "local" },
      { source: "control-ui-admin" },
    );
    if (!capability) {
      throw new Error("expected admin capability");
    }
    const caller = {
      agentId: "main",
      sessionKey: "agent:main:control-ui",
      operationalRunInstance,
      approvalAuthority: authority,
    };

    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity(caller, async () => {
        const mint = bindCronManagementGrant(runId)?.mint;
        expect(mint).toBeTypeOf("function");
        expect(() => mint!("cron.get")).not.toThrow();

        const replacement = createTestAdmittedRunContext(runId).operationalRunInstance;
        const replacementAuthority = claimAgentRunDelegatedAuthority(replacement);
        onTestFinished(() => {
          releaseAgentRunDelegatedAuthority(replacementAuthority);
        });
        await withGatewayToolCallerIdentity(
          {
            ...caller,
            operationalRunInstance: replacement,
            approvalAuthority: replacementAuthority,
          },
          async () => {
            expect(getGatewayToolCallerIdentity()?.approvalAuthority).toBe(replacementAuthority);
            expect(() => mint!("cron.get")).toThrow(
              "Retry from a fresh authenticated configured channel owner or Control UI administrator turn",
            );
          },
        );
      }),
    );
  });
});

describe("fresh remote administrator creation", () => {
  it.each([true, undefined] as const)(
    "separates fresh caller creation (%s) from management and runtime authority",
    async (callerScopedCreation) => {
      const runId = "remote-admin-creation";
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      onTestFinished(() => {
        releaseAgentRunDelegatedAuthority(authority);
      });
      const scope = createCronCreatorAuthorityCapability(
        runId,
        { kind: "unknown" },
        { source: "control-ui-admin" },
        undefined,
        undefined,
        undefined,
        callerScopedCreation,
      )!;
      await runWithCronCreatorAuthorityCapability(scope, () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:remote",
            operationalRunInstance,
            approvalAuthority: authority,
          },
          async () => {
            const management = bindCronManagementGrant(runId)!;
            const requester = bindCronRequesterGrant(runId);
            const resolve = vi.fn();
            expect(management.managementOnly).toBe(!callerScopedCreation);
            expect(bindActiveOperatorTurnAuthority(runId)).toBeUndefined();
            expect(
              runWithCronCreatorAuthorityCapabilityResolver({
                capability: scope,
                runId,
                resolve,
                run: () => bindActiveCronCreatorAuthorityResolver(runId),
              }),
            ).toBeUndefined();
            expect(resolve).not.toHaveBeenCalled();
            expect(() => mintCronCreatorAuthorityGrant(scope)).toThrow(
              "Automation creation is not granted",
            );
            if (!callerScopedCreation) {
              expect(requester).toBeUndefined();
              expect(() => management.mint("cron.add")).toThrow("management-only");
              return;
            }
            expect(management.mint("cron.add")).toBeUndefined();
            const grant = requester!();
            expect(resolveCronCreatorAuthorityGrantProvenance(grant, runId)).toEqual({
              capturesRuntimeAuthority: false,
            });
            expect(consumeCronCreatorAuthorityGrant(grant)).toBeUndefined();
            expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
            const pending = requester!();
            revokeCronCreatorAuthorityRunScope(scope);
            expect(() => consumeCronCreatorAuthorityGrant(pending)).toThrow("no longer active");
            expect(() => requester!()).toThrow("no longer active");
          },
        ),
      );
    },
  );

  it("exposes add but refuses incomplete capture and retired requester authority", async () => {
    const runId = "remote-admin-capture";
    const { operationalRunInstance } = createTestAdmittedRunContext(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(authority);
    });
    const scope = createCronCreatorAuthorityCapability(
      runId,
      { kind: "unknown" },
      { source: "control-ui-admin" },
      undefined,
      undefined,
      undefined,
      true,
    )!;
    await runWithCronCreatorAuthorityCapability(scope, () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:remote",
          operationalRunInstance,
          approvalAuthority: authority,
        },
        async () => {
          const callGatewayTool = vi.fn();
          const tool = createCronTool(
            {
              runId,
              agentSessionKey: "agent:main:remote",
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
        },
      ),
    );
  });
});
