import { expect, it, vi } from "vitest";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  steerTestSessionTurn,
} from "../embedded-agent-runner/runs.test-support.js";
import { runAgentHarnessAttempt } from "./selection.js";
import { createAttemptResult } from "./selection.test-support.js";

/** Registers under the caller's existing registry/generation lifecycle hooks. */
export function registerSelectionQueueInputCases({
  createAttemptParams,
}: {
  createAttemptParams: () => EmbeddedRunAttemptParams;
}): void {
  it.each(["bundled", "config"] as const)(
    "carries the real %s selection into controller queue projection for the same harness ID",
    async (origin) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "codex",
        source: `/fixture/${origin}/codex/index.js`,
        rootDir: `/fixture/${origin}/codex`,
        origin,
        enabled: true,
        configSchema: false,
      });
      builder.registry.plugins.push(record);
      const received = vi.fn();
      const legacyQuestionClaim = vi.fn();
      const synchronousQueue = vi.fn(() => {
        throw new Error("Expected the prepared async sink");
      });
      const asyncQueue = vi.fn();
      builder.createApi(record, { config: {} }).registerAgentHarness({
        id: "codex",
        label: "Queue input adapter fixture",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: async (prepared) => {
          const handle = createEmbeddedRunHandle({
            runId: prepared.runId,
            toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
            supportsTranscriptCommitWait: true,
          });
          handle.messageInjectionV2 = {
            version: 2,
            isAvailable: () => true,
            queueMessage: synchronousQueue,
            queueMessageAsync: async (text, options, preparation) => {
              await preparation.prepareCurrent();
              preparation.assertCurrent();
              asyncQueue();
              received(text, options);
              // The shipped external sink does not know the may-answer field.
              if (origin === "config" && options?.isInboundUserMessage === true) {
                legacyQuestionClaim();
              }
            },
          };
          setActiveEmbeddedRun(
            prepared.sessionId,
            handle,
            prepared.sessionKey,
            prepared.sessionFile,
            prepared.agentId,
          );
          try {
            const host = prepared.hostCapabilities;
            if (!host) {
              throw new Error("Expected host-provided attempt authority");
            }
            const assertCurrent = host.assertActive;
            await expect(
              steerTestSessionTurn(prepared.sessionId, "Keep working; status only", {
                isInboundUserMessage: true,
                allowPendingUserInputAnswer: false,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                assertCurrent,
                toolAuthorityPreparation: {
                  assertCurrent,
                  compatAssertCurrent: assertCurrent,
                  prepareCurrent: async () => assertCurrent(),
                },
              }),
            ).resolves.toMatchObject({ status: "accepted" });
            expect(received).toHaveBeenCalledExactlyOnceWith(
              "Keep working; status only",
              expect.objectContaining({
                isInboundUserMessage: origin === "bundled",
                allowPendingUserInputAnswer: false,
              }),
            );
            expect(asyncQueue).toHaveBeenCalledOnce();
            expect(synchronousQueue).not.toHaveBeenCalled();
            expect(legacyQuestionClaim).not.toHaveBeenCalled();
          } finally {
            clearActiveEmbeddedRun(prepared.sessionId, handle, prepared.sessionKey);
          }
          return createAttemptResult("codex");
        },
      });
      await withPluginRuntimeRegistryScope(builder.registry, async () => {
        await expect(
          runAgentHarnessAttempt({
            ...createAttemptParams(),
            sessionKey: "agent:main:queue-input-adapter",
            agentHarnessRuntimeOverride: "codex",
          }),
        ).resolves.toMatchObject({ sessionIdUsed: "codex" });
      });
    },
  );
}
