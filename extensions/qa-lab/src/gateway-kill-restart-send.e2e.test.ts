import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.js";
import { QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch((error: unknown) => errors.push(error));
  }
  if (errors.length) {
    throw new AggregateError(errors, "hard-kill recovery test cleanup failed");
  }
});

it.skipIf(process.platform === "win32")(
  "recovers a killed run and replies",
  async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const gateway = await owner.start({
      repoRoot,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      forcedRuntime: "openclaw",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: (cfg) => ({
        ...cfg,
        plugins: {
          ...cfg.plugins,
          slots: { ...cfg.plugins?.slots, memory: "none" },
          entries: {
            ...cfg.plugins?.entries,
            acpx: { enabled: false },
            "memory-core": { enabled: false },
          },
        },
        tools: {
          ...cfg.tools,
          alsoAllow: ["qa_restart_wait", "qa_restart_unsafe_probe"],
          // Suspend the 30-second tool so the model's wait is pending at SIGKILL.
          codeMode: { enabled: true, timeoutMs: 10_000 },
        },
      }),
    });
    const conversation = { id: "kill-restart-send", kind: "direct" as const };
    const key = buildAgentSessionKey({
      agentId: "qa",
      channel: "qa-channel",
      accountId: transport.accountId,
      peer: { kind: "direct", id: `dm:${conversation.id}` },
      dmScope: gateway.cfg.session?.dmScope,
      identityLinks: gateway.cfg.session?.identityLinks,
    });
    const readEntry = async () => (await readRawQaSessionStore({ gateway }))[key];
    const readTranscript = (options?: Parameters<typeof readSessionTranscriptSummary>[2]) =>
      readSessionTranscriptSummary({ gateway }, key, options);
    const poll = <T>(check: () => Promise<T | undefined>, timeoutMs = 120_000) =>
      transport.waitForCondition(check, timeoutMs, 25);
    const inbound = { accountId: transport.accountId, conversation, senderId: conversation.id };
    const send = (text: string) => transport.sendInbound({ ...inbound, text });
    const killedLog = "gateway child exited unexpectedly (exitCode=null, signal=SIGKILL)";
    await transport.waitReady({ gateway });
    await send("Code Mode restart wait QA check. Original prompt marker: KILL-RESTART-PROMPT.");
    const pending = await poll(async () => {
      const listed = await gateway.call("sessions.list", { agentId: "qa", activeOnly: true });
      if (!isRecord(listed) || !Array.isArray(listed.sessions)) {
        throw new Error("sessions.list omitted its session rows");
      }
      const active = expect.objectContaining({ key, hasActiveRun: true, status: "running" });
      if (!listed.sessions.some((row) => active.asymmetricMatch(row))) {
        return undefined;
      }
      const entry = await readEntry();
      if (!entry) {
        return undefined;
      }
      const transcript = await readTranscript({ allowEmpty: true, includeCodeModeControl: true });
      return (transcript.assistantToolCallCounts.wait ?? 0) >
        (transcript.completedToolCallCounts.wait ?? 0)
        ? { entry, transcript }
        : undefined;
    });
    expect(pending.entry.status).toBeUndefined();
    expect(pending.entry.restartRecoveryDeliveryRunId).toEqual(expect.any(String));
    const pid = gateway.pid;
    expect(pid).not.toBeNull();
    expect(signalQaPosixProcessGroup(pid!, "SIGKILL")).toBeUndefined();
    await waitForQaTransportCondition(
      () =>
        !isQaPosixProcessGroupAlive(pid!) && gateway.logs().includes(killedLog) ? true : undefined,
      30_000,
      25,
    );
    await gateway.restartAfterStateMutation(async () => {
      const orphan = await readEntry();
      expect(orphan).toMatchObject({
        sessionId: pending.entry.sessionId,
        restartRecoveryDeliveryRunId: pending.entry.restartRecoveryDeliveryRunId,
      });
      expect(orphan?.status).toBeUndefined();
      expect(orphan?.abortedLastRun).not.toBe(true);
    });
    expect(gateway.pid).not.toBe(pid);
    await transport.waitReady({ gateway });
    await poll(async () =>
      gateway.logs().includes("dispatching restart-safe recovery") &&
      (await readTranscript()).eventCursor > pending.transcript.eventCursor
        ? true
        : undefined,
    );
    expect(gateway.logs()).toContain("marked 1 startup-orphaned main session(s)");
    const { messages } = state.getSnapshot();
    const sinceIndex = messages.filter((message) => message.direction === "outbound").length;
    // The current-turn fixture takes precedence over the restart prompt in history.
    const second = await send("repeated request queued reply gateway qa check");
    const reply = await transport.waitForOutbound({
      conversation,
      sinceIndex,
      textIncludes: QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER,
      timeoutMs: 180_000,
    });
    expect(reply).toMatchObject({ replyToId: second.id, accountId: transport.accountId });
    const settled = await poll(async () => {
      const entry = await readEntry();
      return entry?.status === "done" ? entry : undefined;
    }, 30_000);
    expect(settled.sessionId).toBe(pending.entry.sessionId);
  },
  600_000,
);
