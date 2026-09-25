import { expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  replaceSessionEntry,
  type loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { readInProcessSessionSendPolicy } from "../../gateway/in-process-session-send-policy.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import * as sessionTranscriptReaders from "../../gateway/session-transcript-readers.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import {
  makeAssistantTextMessage,
  makeMessageToolCall,
  makeToolResultMessage,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";

type RecoveryCounts = { started: number; settled: number; failed: number; skipped: number };
type MainSessionFixture = { sessionsDir: string; storePath: string; sessionKey: string };
type RecoveryInputPolicyFixture = {
  tmpDir: string;
  makeMainSessionFixture: (
    overrides?: SessionEntryFixture & { agentId?: string; sessionKey?: string },
  ) => Promise<MainSessionFixture>;
  makeDeliveredReceiptFixture: (
    toolCallId?: string,
    sourceRunId?: string,
    overrides?: SessionEntryFixture,
  ) => Promise<MainSessionFixture>;
  makePendingFinalDelivery: (
    text?: string,
    overrides?: Partial<NonNullable<SessionEntry["pendingFinalDelivery"]>>,
  ) => NonNullable<SessionEntry["pendingFinalDelivery"]>;
  makeSessionsDir: (agentId?: string) => Promise<string>;
  writeMainSession: (
    entry: SessionEntryFixture & { sessionsDir: string; sessionKey?: string },
  ) => Promise<void>;
  writeTranscript: (
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ) => Promise<void>;
  expectRecovery: (expected: RecoveryCounts, cfg?: OpenClawConfig) => Promise<void>;
  mockRecoveryRuntime: GatewayRecoveryRuntime;
  gatewayParams: () => Record<string, unknown>;
  loadSessionEntry: (scope: Parameters<typeof loadSessionEntry>[0]) => SessionEntry | undefined;
  recoverRestartAbortedMainSessions: (params: { stateDir: string }) => Promise<RecoveryCounts>;
  sendRecoveryNotice: Mock<GatewayRecoveryRuntime["sendRecoveryNotice"]>;
};

export function registerRecoveryInputPolicyTests(
  getFixture: () => RecoveryInputPolicyFixture,
): void {
  it.each([true, false])(
    "restores only the interrupted input policy (claimed source=%s)",
    async (claimedSource) => {
      const {
        makeMainSessionFixture,
        writeTranscript,
        expectRecovery,
        mockRecoveryRuntime,
        gatewayParams,
      } = getFixture();
      const metadata = (deny: string[]) => ({
        delegatedInputPolicyVersion: 2,
        delegatedInputPolicy: {
          clauses: [{ kind: "configured", deny }],
          parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
        },
      });
      const { sessionsDir } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "delivery-run",
        ...(claimedSource ? { restartRecoveryDeliverySourceRunId: "original-source" } : {}),
        lifecycleRunId: "physical-run",
        restartRecoveryRuns: [{ runId: "physical-run", lifecycleGeneration: "old-process" }],
      });
      await writeTranscript(sessionsDir, "main-session", [
        makeUserMessage("original input", {
          idempotencyKey: "original-source:user",
          __openclaw: metadata(["exec"]),
        }),
        makeUserMessage("accepted steer", {
          __openclaw: { ...metadata(["write"]), steerTargetRunId: "physical-run" },
        }),
        makeAssistantTextMessage("interrupted checkpoint", {
          __openclaw: { ...metadata(["message"]), runId: "delivery-run" },
        }),
        makeUserMessage("unrelated historical restrictions", {
          idempotencyKey: "unrelated-source:user",
          __openclaw: metadata(["read"]),
        }),
        makeToolResultMessage(),
      ]);
      const dispatch = vi.spyOn(mockRecoveryRuntime, "dispatchAgent");
      try {
        await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
        const admission = readInProcessSessionSendPolicy(dispatch.mock.calls[0]?.[2]);
        expect(admission?.kind).toBe("recovery");
        expect(admission?.policy.clauses).toHaveLength(claimedSource ? 3 : 2);
        expect(admission?.policy.clauses).toEqual(
          expect.arrayContaining([
            { kind: "configured", deny: ["message"] },
            { kind: "configured", deny: ["write"] },
            ...(claimedSource ? [{ kind: "configured", deny: ["exec"] }] : []),
          ]),
        );
        expect(gatewayParams()).not.toHaveProperty("delegatedInputPolicy");
      } finally {
        dispatch.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "missing interrupted source blocks work but preserves completed delivery (settled=%s)",
    async (settled) => {
      const { makeMainSessionFixture, makePendingFinalDelivery, writeTranscript, expectRecovery } =
        getFixture();
      const { sessionsDir } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "delivery-run",
        restartRecoveryDeliverySourceRunId: "missing-source",
        ...(settled
          ? {
              pendingFinalDelivery: makePendingFinalDelivery("already delivered", {
                deliveries: [{ id: "delivered-result", state: "delivered" }],
              }),
            }
          : {}),
      });
      await writeTranscript(sessionsDir, "main-session", [
        makeUserMessage("different input", { idempotencyKey: "other-source:user" }),
        makeToolResultMessage(),
      ]);
      await expectRecovery({
        started: 0,
        settled: settled ? 1 : 0,
        failed: settled ? 0 : 1,
        skipped: 0,
      });
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("rejects a same-id replacement while interrupted input policy is being read", async () => {
    const {
      makeMainSessionFixture,
      writeTranscript,
      recoverRestartAbortedMainSessions,
      tmpDir,
      loadSessionEntry,
    } = getFixture();
    const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
      lifecycleRevision: "original-generation",
      restartRecoveryDeliveryRunId: "delivery-run",
      restartRecoveryDeliverySourceRunId: "original-source",
    });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("original input", { idempotencyKey: "original-source:user" }),
      makeToolResultMessage(),
    ]);
    const entered = createDeferred();
    const release = createDeferred();
    const read = sessionTranscriptReaders.readSessionRunInputPolicyAsync;
    const spy = vi
      .spyOn(sessionTranscriptReaders, "readSessionRunInputPolicyAsync")
      .mockImplementation(async (...args) => {
        const policy = await read(...args);
        entered.resolve();
        await release.promise;
        return policy;
      });
    const recovery = recoverRestartAbortedMainSessions({ stateDir: tmpDir });
    try {
      await Promise.race([
        entered.promise,
        recovery.then(() => {
          throw new Error("Recovery completed without reading interrupted input policy");
        }),
      ]);
      const current = loadSessionEntry({ sessionKey, storePath });
      if (!current) {
        throw new Error("Expected the interrupted session fixture");
      }
      await replaceSessionEntry(
        { sessionKey, storePath },
        { ...current, lifecycleRevision: "replacement-generation" },
      );
      release.resolve();
      await expect(recovery).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ sessionKey, storePath })?.lifecycleRevision).toBe(
        "replacement-generation",
      );
    } finally {
      release.resolve();
      await recovery;
      spy.mockRestore();
    }
  });
}

export function registerPendingDeliveryInputRecoveryTests(
  getFixture: () => RecoveryInputPolicyFixture,
): void {
  it.each([
    ["missing", undefined],
    ["empty", []],
  ] as const)(
    "resumes safely when pending final delivery identities are %s",
    async (_, deliveries) => {
      const {
        makeSessionsDir,
        writeMainSession,
        writeTranscript,
        expectRecovery,
        gatewayParams,
        sendRecoveryNotice,
      } = getFixture();
      const sessionsDir = await makeSessionsDir();
      const pendingPayload = "The final answer is 42.";
      await writeMainSession({
        sessionsDir,
        restartRecoveryForceSafeTools: true,
        pendingFinalDelivery: {
          kind: "replayable",
          text: pendingPayload,
          createdAt: Date.now() - 5_000,
          ...(deliveries ? { deliveries: [...deliveries] } : {}),
          context: {
            channel: "discord",
            to: "discord:dm:final",
            accountId: "main",
          },
        },
        restartRecoveryBeforeAgentReplyState: "handled-reply",
        restartRecoveryDeliveryRunId: "discord-message-1",
        restartRecoveryDeliverySourceRunId: "discord-message-1",
        restartRecoverySourceIngress: "channel",
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        makeUserMessage("calculate the answer", { idempotencyKey: "discord-message-1:user" }),
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
        { role: "toolResult", content: "42" },
      ]);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 }, {});
      expect(callGateway).toHaveBeenCalledOnce();
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      expect(gatewayParams().message).toContain(pendingPayload);
      expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/:resumed-notice$/),
        }),
      );
    },
  );
}

export function registerMissingTerminalSourceRecoveryTest(
  getFixture: () => RecoveryInputPolicyFixture,
): void {
  it("refuses unfinished terminal reconciliation when the durable source turn is missing", async () => {
    const {
      makeDeliveredReceiptFixture,
      writeTranscript,
      expectRecovery,
      sendRecoveryNotice,
      loadSessionEntry,
    } = getFixture();
    const { sessionsDir, storePath, sessionKey } = await makeDeliveredReceiptFixture(
      "message-call-1",
      "discord-message-missing",
    );
    await writeTranscript(sessionsDir, "main-session", [makeMessageToolCall()]);

    await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryDeliverySourceRunId: "discord-message-missing",
    });
  });
}
