import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../../src/config.js";
import type { CoreAgentDeps, CoreConfig } from "../../src/core-bridge.js";
import { CallManager } from "../../src/manager.js";
import { flushPendingCallRecordWritesForTest } from "../../src/manager/store.js";
import type { VoiceCallProvider } from "../../src/providers/base.js";
import { generateVoiceResponse } from "../../src/response-generator.js";
import { resolveCallAgentId } from "../../src/util/resolve-call-agent-id.js";

/**
 * Integration smoke for per-agent voice routing. Drives the real seam:
 *   manager.initiateCall → CallRecord.agentId → resolveCallAgentId →
 *   generateVoiceResponse params.agentId → agent workspace resolution.
 *
 * Stubs only the outermost provider + agent runtime; everything between is
 * production code.
 */

function createProviderStub(): VoiceCallProvider {
  return {
    name: "mock",
    verifyWebhook: () => ({ ok: true }),
    parseWebhookEvent: () => ({ events: [] }),
    initiateCall: vi.fn(async () => ({ providerCallId: "prov-1", status: "initiated" })),
    hangupCall: async () => {},
    playTts: async () => {},
    startListening: async () => {},
    stopListening: async () => {},
    getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
  } as VoiceCallProvider;
}

function createAgentRuntimeStub(payloadText: string) {
  const runEmbeddedPiAgent = vi.fn(async () => ({
    payloads: [{ text: payloadText }],
    meta: { durationMs: 1, aborted: false },
  }));
  const runtime = {
    defaults: { provider: "mock", model: "mock-model" },
    resolveAgentDir: vi.fn((_cfg: CoreConfig, agentId: string) => `/tmp/agents/${agentId}`),
    resolveAgentWorkspaceDir: vi.fn(
      (_cfg: CoreConfig, agentId: string) => `/tmp/workspace/${agentId}`,
    ),
    resolveAgentIdentity: vi.fn(() => ({ name: "tester" })),
    resolveThinkingDefault: () => "off",
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => {},
    runEmbeddedPiAgent,
    session: {
      resolveStorePath: vi.fn(
        (_store: string | undefined, params: { agentId?: string }) =>
          `/tmp/${params.agentId ?? "main"}/sessions.json`,
      ),
      loadSessionStore: () => ({}),
      saveSessionStore: vi.fn(async () => {}),
      updateSessionStore: vi.fn(
        async (_storePath: string, mutator: (store: Record<string, unknown>) => unknown) => {
          const store: Record<string, unknown> = {};
          return await mutator(store);
        },
      ),
      resolveSessionFilePath: vi.fn(
        (_sessionId: string, _entry: unknown, params: { agentId?: string }) =>
          `/tmp/${params.agentId ?? "main"}/session.jsonl`,
      ),
    },
  } as unknown as CoreAgentDeps;
  return { runtime, runEmbeddedPiAgent };
}

describe("per-agent voice call routing — integration", () => {
  const storeDirs: string[] = [];

  afterEach(async () => {
    await flushPendingCallRecordWritesForTest();
    for (const dir of storeDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-per-agent-routing-"));
    storeDirs.push(dir);
    return dir;
  }

  it("CallRecord.agentId persists from initiateCall through to generateVoiceResponse", async () => {
    const storePath = makeStore();
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      fromNumber: "+15550000000",
      // Plugin-level default agent — should be ignored when call has its own.
      agentId: "config-default",
      store: storePath,
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(createProviderStub(), "https://example.com/wh");

    const result = await manager.initiateCall("+15550009999", undefined, {
      message: "hello",
      agentId: "slack-u123",
    });
    expect(result.success).toBe(true);

    const stored = manager.getCall(result.callId);
    expect(stored).toBeDefined();
    expect(stored?.agentId).toBe("slack-u123");

    // Helper resolves call.agentId over config.
    expect(resolveCallAgentId(stored!, config)).toBe("slack-u123");

    // Drive generateVoiceResponse with the resolved agentId — proves the
    // params.agentId override threads into runEmbeddedPiAgent.
    const { runtime, runEmbeddedPiAgent } = createAgentRuntimeStub('{"spoken":"OK"}');
    await generateVoiceResponse({
      voiceConfig: config,
      coreConfig: {} as CoreConfig,
      agentRuntime: runtime,
      callId: stored!.callId,
      sessionKey: stored!.sessionKey,
      from: stored!.from,
      agentId: resolveCallAgentId(stored!, config),
      transcript: [],
      userMessage: "hi",
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "slack-u123" }),
    );
  });

  it("falls back to effectiveConfig.agentId when call.agentId is unset (legacy outbound)", async () => {
    const storePath = makeStore();
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      fromNumber: "+15550000000",
      agentId: "owner",
      store: storePath,
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(createProviderStub(), "https://example.com/wh");

    const result = await manager.initiateCall("+15550009999", undefined, { message: "hello" });
    expect(result.success).toBe(true);
    const stored = manager.getCall(result.callId);
    expect(stored?.agentId).toBeUndefined();
    expect(resolveCallAgentId(stored!, config)).toBe("owner");

    const { runtime, runEmbeddedPiAgent } = createAgentRuntimeStub('{"spoken":"OK"}');
    await generateVoiceResponse({
      voiceConfig: config,
      coreConfig: {} as CoreConfig,
      agentRuntime: runtime,
      callId: stored!.callId,
      sessionKey: stored!.sessionKey,
      from: stored!.from,
      agentId: resolveCallAgentId(stored!, config),
      transcript: [],
      userMessage: "hi",
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "owner" }));
  });
});
