import "openclaw/plugin-sdk/compiled-subprocess-testing";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { VoiceCallConfigSchema } from "./config.js";
import { generateVoiceResponse } from "./response-generator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
afterAll(() => closeOpenClawAgentDatabasesAsync());
afterEach(resetPluginRuntimeStateForTest);

it("uses the actor for an explicit same-agent key and the native owner for generated call keys", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("voice-bound-") };
  const storePath = resolveStorePath(undefined, { agentId: "main", env });
  const authority = { assertCurrent() {} };
  const actor = await openIncognitoTestActor(env, authority);
  const sessionKey = "agent:main:dashboard:incognito-voice";
  const { config, registry } = createPluginRegistryFixture({ session: { store: storePath } });
  let session: OpenClawPluginApi["runtime"]["agent"]["session"] | undefined;
  registerVirtualTestPlugin({
    config,
    registry,
    id: "voice-test",
    name: "Voice test",
    register: (api) => {
      session = api.runtime.agent.session;
    },
  });
  setActivePluginRegistry(registry.registry);
  if (!session) {
    throw new Error("Voice fixture did not receive the host session owner");
  }
  const runEmbeddedAgent = vi.fn(async () => ({
    payloads: [{ text: '{"spoken":"A private reply."}' }],
    meta: { durationMs: 1, aborted: false },
  }));
  const agentRuntime = {
    session,
    defaults: { provider: "openai", model: "gpt-4.1-mini" },
    resolveAgentDir: () => "/synthetic/agent",
    resolveAgentWorkspaceDir: () => "/synthetic/workspace",
    ensureAgentWorkspace: async () => {},
    resolveAgentIdentity: () => ({ name: "Voice fixture" }),
    resolveThinkingDefault: () => "off" as const,
    resolveAgentTimeoutMs: () => 5_000,
    runEmbeddedAgent,
  } as OpenClawPluginApi["runtime"]["agent"];
  const run = (explicitSessionKey?: string) =>
    generateVoiceResponse({
      voiceConfig: VoiceCallConfigSchema.parse({}),
      coreConfig: config,
      agentRuntime,
      agentId: "main",
      callId: "call-1",
      from: "+15550001111",
      senderIsOwner: false,
      transcript: [],
      userMessage: "Hello",
      sessionKey: explicitSessionKey,
    });
  try {
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId: "private-call", updatedAt: 1, incognito: true },
    });
    await withIncognitoSessionBinding({ actor }, async () => {
      const sql = observeHostDataSql();
      try {
        expect(await run(sessionKey)).toEqual({ text: "A private reply.", deliveredEarly: false });
        expect(runEmbeddedAgent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sessionId: "private-call",
            sessionKey,
          }),
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(await run()).toEqual({ text: "A private reply.", deliveredEarly: false });
    });
    const generatedKey = "agent:main:voice:15550001111";
    expect(await getSessionEntryAsync({ storePath, sessionKey: generatedKey })).toBeDefined();
    expect(runEmbeddedAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionKey: generatedKey }),
    );
  } finally {
    await actor.close();
  }
});
