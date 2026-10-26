import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import * as relayRuntime from "../../plugin-sdk/native-hook-relay-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { invokeNativeHookRelay } from "./native-hook-relay.js";
import { clearNativeHookRelaysForTests } from "./native-hook-relay.test-support.js";

const { createCodexNativeSpawnRelayForTest } = await loadBundledPluginFacade<{
  createCodexNativeSpawnRelayForTest: (params: {
    hostCapabilities: AgentHarnessHostCapabilities;
    runId: string;
    sessionKey: string;
    namespace: string;
  }) => ReturnType<typeof relayRuntime.registerNativeHookRelayForBundledRuntime>;
}>({ pluginId: "codex", artifactBasename: "native-hook-test-api.js" });

afterEach(async () => {
  vi.restoreAllMocks();
  await clearNativeHookRelaysForTests();
  vi.useRealTimers();
});

it("keeps collaborative native spawn under the incumbent and refuses an ended parent", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const admittedCalls: string[] = [];
  const register = relayRuntime.registerNativeHookRelayForBundledRuntime;
  vi.spyOn(relayRuntime, "registerNativeHookRelayForBundledRuntime").mockImplementation(
    (params) => {
      const admission = expectDefined(params.executionAdmission, "native spawn admission");
      return register({
        ...params,
        executionAdmission: {
          ...admission,
          admit: async (invocation, assertCurrent, preparation) => {
            const assertAdmitted = await admission.admit(invocation, assertCurrent, preparation);
            expect(getGatewayToolCallerIdentity()?.operatorAuthority).toMatchObject({
              profileId: "alice",
              scopes: ["operator.read", "operator.write"],
            });
            admittedCalls.push(invocation.toolUseId ?? "missing-tool-call");
            if (invocation.toolUseId === "pending-spawn") {
              entered.resolve();
              await resume.promise;
            }
            return assertAdmitted;
          },
        },
      });
    },
  );
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "alice",
    scopes: ["operator.read", "operator.write"],
    gatewayAccessGrant: null,
    modelPolicy: prepareOperatorModelPolicy({ cfg: {}, policy: {} }),
    assertCurrent() {},
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    "personal-tool-run",
    "main",
    "native-spawn-test",
    undefined,
    operatorAuthority,
  );
  const admittedRunContext = await admission.admit("plugin-harness", "codex");
  // Production creates the host before the prepared turn scope publishes participants.
  const host = createAgentHarnessHostCapabilities({
    attempt: {
      admittedRunContext,
      runId: "personal-tool-run",
      agentId: "main",
      sessionKey: "agent:main:personal-tools",
    },
    pluginId: "codex",
  });
  try {
    await withPersonalToolTurn(
      {
        owner: { profileId: "alice", senderId: "alice-sender", name: "Alice", operatorAuthority },
        admittedRunContext,
        allowCollaborativeSteering: true,
      },
      async (turn) =>
        host.runWithScope(async () => {
          const relay = createCodexNativeSpawnRelayForTest({
            sessionKey: turn.runtimeIdentity.sessionKey,
            runId: turn.runtimeIdentity.operationalRunInstance.runId,
            hostCapabilities: host.capabilities,
            namespace: "crew",
          });
          const invoke = (toolName: string, callId: string) =>
            invokeNativeHookRelay({
              provider: "codex",
              relayId: relay.relayId,
              event: "pre_tool_use",
              rawPayload: {
                session_id: "parent-thread",
                turn_id: "parent-turn",
                tool_use_id: callId,
                tool_name: toolName,
                tool_input: { task_name: "child", message: "Inspect the fixture" },
              },
            });
          try {
            await expect(
              turn.steer(
                { profileId: "bob", senderId: "bob-sender", name: "Bob" },
                { scopes: ["operator.read"] },
              ),
            ).resolves.toMatchObject({ status: "accepted" });
            expect(turn.operation.personalToolParticipants?.resolve("bob")?.profileId).toBe("bob");
            const names = ["Agent", "spawn_agent", "crewspawn_agent"];
            const success = { stdout: "", stderr: "", exitCode: 0 };
            for (const name of names) {
              await expect(invoke(name, `single-${name}`)).resolves.toEqual(success);
            }
            expect(admittedCalls).toEqual(names.map((name) => `single-${name}`));
            const pending = invoke("Agent", "pending-spawn");
            await awaitGateBeforeSettlement(entered.promise, pending, "Spawn bypassed admission");
            await turn.complete();
            resume.resolve();
            const expectDenied = (response: Awaited<ReturnType<typeof invoke>>) => {
              expect(JSON.parse(response.stdout)).toMatchObject({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: expect.stringMatching(/turn has ended/),
                },
              });
              expect(response.exitCode).toBe(0);
            };
            expectDenied(await pending);
            for (const name of names) {
              expectDenied(await invoke(name, `ended-${name}`));
            }
          } finally {
            resume.resolve();
            relay.unregister();
            await relay.drain();
          }
        }),
    );
  } finally {
    host.close();
    admission.close();
  }
});
