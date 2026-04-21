import { describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { createPostCallRelayHook, formatTranscriptForRelay } from "./post-call-relay.js";
import type { CallRecord } from "./types.js";

async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-test",
    providerCallId: "CA-test",
    provider: "twilio",
    direction: "outbound",
    state: "completed",
    from: "+15550000001",
    to: "+15550000002",
    startedAt: 1_700_000_000_000,
    answeredAt: 1_700_000_005_000,
    endedAt: 1_700_000_065_000,
    endReason: "hangup-user",
    transcript: [
      { timestamp: 1_700_000_010_000, speaker: "bot", text: "Hi Nana!", isFinal: true },
      {
        timestamp: 1_700_000_020_000,
        speaker: "user",
        text: "Hi — dinner Sunday at six works.",
        isFinal: true,
      },
    ],
    processedEventIds: [],
    ...overrides,
  };
}

function makeVoiceConfig(overrides: Partial<VoiceCallConfig["postCall"]> = {}): VoiceCallConfig {
  return {
    postCall: {
      enabled: true,
      minTranscriptEntries: 2,
      timeoutMs: 60_000,
      ...overrides,
    },
    // The relay hook only reads `postCall`; everything else is filled in
    // opaquely for typing. Cast through unknown to avoid rebuilding the full
    // zod-shaped fixture.
  } as unknown as VoiceCallConfig;
}

function makeAgentRuntime(runEmbeddedPiAgent = vi.fn().mockResolvedValue({ payloads: [] })): {
  runtime: CoreAgentDeps;
  runEmbeddedPiAgent: typeof runEmbeddedPiAgent;
} {
  const runtime = {
    runEmbeddedPiAgent,
    resolveAgentDir: vi.fn(() => "/tmp/agent"),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
    resolveThinkingDefault: vi.fn(() => "off"),
    resolveAgentIdentity: vi.fn(() => undefined),
    resolveAgentTimeoutMs: vi.fn(() => 30_000),
    defaults: { provider: "anthropic", model: "sonnet-4.6" },
    session: {
      resolveStorePath: vi.fn(() => "/tmp/store"),
      loadSessionStore: vi.fn(() => ({})),
      saveSessionStore: vi.fn().mockResolvedValue(undefined),
      resolveSessionFilePath: vi.fn(() => "/tmp/session.jsonl"),
    },
  } as unknown as CoreAgentDeps;
  return { runtime, runEmbeddedPiAgent };
}

describe("formatTranscriptForRelay", () => {
  it("builds a deterministic header and body from a call record", () => {
    const { header, body } = formatTranscriptForRelay(makeCall());
    expect(header).toMatch(/VOICE CALL ENDED/);
    expect(header).toMatch(/outbound/);
    expect(header).toMatch(/\+15550000002/);
    expect(header).toMatch(/duration 1m 5s/);
    expect(body).toBe(
      ["Assistant: Hi Nana!", "Caller: Hi — dinner Sunday at six works."].join("\n"),
    );
  });

  it("reports (no spoken content captured) when the transcript is empty", () => {
    const { body } = formatTranscriptForRelay(makeCall({ transcript: [] }));
    expect(body).toBe("(no spoken content captured)");
  });
});

describe("createPostCallRelayHook", () => {
  const coreConfig: CoreConfig = {};

  it("dispatches a relay task with header, transcript, and default instruction", async () => {
    const { runtime, runEmbeddedPiAgent } = makeAgentRuntime();
    const hook = createPostCallRelayHook({
      voiceConfig: makeVoiceConfig({ channelMention: "your Slack DM" }),
      coreConfig,
      agentRuntime: runtime,
    });

    hook(makeCall());

    // Hook dispatches asynchronously; flush pending promises.
    await flushAsync();

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const [args] = runEmbeddedPiAgent.mock.calls[0];
    expect(args.sessionKey).toBe("voice:15550000002");
    expect(args.lane).toBe("voice");
    expect(args.messageProvider).toBe("voice");
    expect(args.prompt).toMatch(/VOICE CALL ENDED/);
    expect(args.prompt).toMatch(/TRANSCRIPT:\nAssistant: Hi Nana!/);
    expect(args.prompt).toMatch(/Caller: Hi — dinner Sunday at six works\./);
    expect(args.prompt).toMatch(/INSTRUCTION: /);
    expect(args.prompt).toMatch(/via your Slack DM/);
    expect(args.timeoutMs).toBe(60_000);
  });

  it("uses the custom instruction template verbatim when configured", async () => {
    const { runtime, runEmbeddedPiAgent } = makeAgentRuntime();
    const hook = createPostCallRelayHook({
      voiceConfig: makeVoiceConfig({ instruction: "CUSTOM INSTRUCTION TEMPLATE." }),
      coreConfig,
      agentRuntime: runtime,
    });
    hook(makeCall());
    await flushAsync();

    const [args] = runEmbeddedPiAgent.mock.calls[0];
    expect(args.prompt).toMatch(/INSTRUCTION: CUSTOM INSTRUCTION TEMPLATE\./);
  });

  it("skips relay when postCall is disabled", async () => {
    const { runtime, runEmbeddedPiAgent } = makeAgentRuntime();
    const hook = createPostCallRelayHook({
      voiceConfig: makeVoiceConfig({ enabled: false }),
      coreConfig,
      agentRuntime: runtime,
    });
    hook(makeCall());
    await flushAsync();

    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("skips relay for short transcripts below the configured minimum", async () => {
    const { runtime, runEmbeddedPiAgent } = makeAgentRuntime();
    const hook = createPostCallRelayHook({
      voiceConfig: makeVoiceConfig({ minTranscriptEntries: 5 }),
      coreConfig,
      agentRuntime: runtime,
    });
    hook(makeCall());
    await flushAsync();

    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("does not throw if agent dispatch rejects", async () => {
    const runEmbeddedPiAgent = vi.fn().mockRejectedValue(new Error("agent unreachable"));
    const { runtime } = makeAgentRuntime(runEmbeddedPiAgent);
    const warn = vi.fn();

    const hook = createPostCallRelayHook({
      voiceConfig: makeVoiceConfig(),
      coreConfig,
      agentRuntime: runtime,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });

    expect(() => hook(makeCall())).not.toThrow();
    await flushAsync();
    // Let the rejected promise surface so the error handler runs.
    await flushAsync();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Post-call relay dispatch failed"));
  });
});
