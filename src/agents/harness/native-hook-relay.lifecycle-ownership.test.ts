import { afterEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { claimAndVerifyRelayTurn } from "./native-hook-relay-ownership.js";
import * as store from "./native-hook-relay-store.js";
import {
  invokeNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";
import { expectConcurrentRelayOwnerPreservesPreparation } from "./native-hook-relay.lifecycle.test-support.js";

afterEach(async () => {
  await testing.clearNativeHookRelaysForTests();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

it("binds native process authority after ownership claim and before readiness", async () => {
  const order: string[] = [];
  await claimAndVerifyRelayTurn(
    {
      claimTurn: () => {
        order.push("claim");
        return true;
      },
      verifyPreToolUse: async () => {
        order.push("verify");
      },
    },
    "turn-1",
    () => order.push("assert"),
    () => order.push("bind"),
  );

  expect(order).toEqual(["claim", "assert", "bind", "assert", "verify", "assert"]);
});

it("rejects a refused turn claim before binding process authority or readiness", async () => {
  const order: string[] = [];

  await expect(
    claimAndVerifyRelayTurn(
      {
        claimTurn: () => {
          order.push("claim");
          return false;
        },
        verifyPreToolUse: async () => {
          order.push("verify");
        },
      },
      "turn-duplicate",
      () => order.push("assert"),
      () => order.push("bind"),
    ),
  ).rejects.toThrow("native hook relay turn claim rejected");

  expect(order).toEqual(["claim"]);
});

it.each(["cancellation", "replacement", "foreground retirement"] as const)(
  "rejects logical preparation after %s while publication is held",
  async (retirement) => {
    await withOpenClawTestState({ label: "relay-prepare-retirement" }, async () => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const write = store.writeNativeHookRelayBridgeRecord;
      vi.spyOn(store, "writeNativeHookRelayBridgeRecord").mockImplementationOnce(async (params) => {
        entered.resolve();
        await resume.promise;
        await write(params);
      });
      const policy = vi.fn(() => ({ block: true, blockReason: "retired policy must not run" }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: policy }]),
      );
      const host = await createAdmittedHostCapabilityTestFixture({ runId: "prepare-retirement" });
      const abort = new AbortController();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        relayId: "prepare-retirement",
        sessionId: "prepare-retirement",
        runId: "prepare-retirement",
        signal: abort.signal,
        allowedEvents: ["pre_tool_use"],
        runBeforeToolCall: host.hostCapabilities.runBeforeToolCall,
        assertActive: host.hostCapabilities.assertActive,
        retention: {
          readClaim: () => undefined,
          shouldRetainAfterForegroundClose: () => retirement === "foreground retirement",
          allowPreToolUse: () => false,
          onDispose: () => {},
        },
      });
      let successor: ReturnType<typeof registerOwnedNativeHookRelay> | undefined;
      let preparation: Promise<void> | undefined;
      let settled = false;
      try {
        preparation = relay.prepareInvocation();
        void preparation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await entered.promise;
        expect(settled).toBe(false);
        if (retirement === "cancellation") {
          abort.abort();
        } else if (retirement === "replacement") {
          successor = registerOwnedNativeHookRelay({
            provider: "codex",
            relayId: relay.relayId,
            sessionId: "prepare-retirement",
            runId: "prepare-successor",
          });
        } else {
          relay.unregister();
          expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
        }
        resume.resolve();
        const originalInvocation = () =>
          invokeNativeHookRelay({
            provider: "codex",
            relayId: relay.relayId,
            generation: relay.generation,
            requireGeneration: true,
            event: "pre_tool_use",
            rawPayload: { tool_name: "Bash", tool_input: { command: "echo synthetic" } },
          });
        if (retirement === "replacement") {
          await expectConcurrentRelayOwnerPreservesPreparation({
            preparation,
            invoke: originalInvocation,
            policy,
          });
        } else {
          await expect(preparation).rejects.toThrow(/inactive|foreground|abort/i);
          await expect(originalInvocation()).rejects.toThrow();
          expect(policy).not.toHaveBeenCalled();
        }
        if (successor) {
          await successor.ready;
          expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)?.runId).toBe(
            "prepare-successor",
          );
          expect(
            await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }),
          ).toBeDefined();
        }
      } finally {
        resume.resolve();
        abort.abort();
        successor?.unregister();
        await Promise.allSettled([
          preparation,
          relay.drain(),
          ...(successor ? [successor.drain()] : []),
        ]);
        host.closeHost();
        host.closeAdmission();
        resetGlobalHookRunner();
      }
    });
  },
);
