import { afterEach, expect, it, vi } from "vitest";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import * as relayRuntime from "../../plugin-sdk/native-hook-relay-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { invokeNativeHookRelay, testing } from "./native-hook-relay.js";

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
  await testing.clearNativeHookRelaysForTests();
  vi.useRealTimers();
});

it("denies native spawn at final admission when another person steers the parent", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const register = relayRuntime.registerNativeHookRelayForBundledRuntime;
  vi.spyOn(relayRuntime, "registerNativeHookRelayForBundledRuntime").mockImplementation(
    (params) => {
      const admission = params.executionAdmission;
      return register({
        ...params,
        ...(admission
          ? {
              executionAdmission: {
                ...admission,
                admit: async (invocation, assertCurrent, preparation) => {
                  const assertAdmitted = await admission.admit(
                    invocation,
                    assertCurrent,
                    preparation,
                  );
                  if (invocation.toolUseId === "pending-spawn") {
                    entered.resolve();
                    await resume.promise;
                  }
                  return assertAdmitted;
                },
              },
            }
          : {}),
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
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "personal-tool-run",
      agentId: "main",
      ingress: { kind: "system", state: "present", boundary: "native-spawn-test" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("personal-tool-run"),
    operatorAuthority,
  });
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
            for (const name of ["Agent", "spawn_agent", "crewspawn_agent"]) {
              await expect(invoke(name, `single-${name}`)).resolves.toEqual({
                stdout: "",
                stderr: "",
                exitCode: 0,
              });
            }
            const pending = invoke("Agent", "pending-spawn");
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("Native spawn bypassed execution admission");
              }),
            ]);
            await expect(
              turn.steer({ profileId: "bob", senderId: "bob-sender", name: "Bob" }),
            ).resolves.toMatchObject({ status: "accepted" });
            resume.resolve();
            const ambiguity =
              /Alice \(user: alice\).*Bob \(user: bob\).*Use sessions_spawn with the requester's requester_profile\.id as user/;
            const expectDenied = (response: Awaited<ReturnType<typeof invoke>>, reason: RegExp) => {
              expect(JSON.parse(response.stdout)).toMatchObject({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: expect.stringMatching(reason),
                },
              });
              expect(response.exitCode).toBe(0);
            };
            expectDenied(await pending, ambiguity);
            for (const name of ["Agent", "spawn_agent", "crewspawn_agent"]) {
              expectDenied(await invoke(name, `ambiguous-${name}`), ambiguity);
            }
            turn.complete();
            expectDenied(await invoke("Agent", "ended-spawn"), /turn has ended/);
          } finally {
            resume.resolve();
            relay.unregister();
            await relay.drain();
          }
        }),
    );
  } finally {
    host.close();
    await admission.close();
  }
});
