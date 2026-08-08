import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  clearCodexNativeHookRelayOwners,
  codexNativeHookRelayOwnerCount,
} from "./native-hook-relay.test-harness.js";
import type { CodexModelListResponse } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_CODEX_NATIVE_HOOK_RELAY === "1";
const describeLive = LIVE ? describe : describe.skip;

const CODEX_MULTI_AGENT_ARGS = [
  "app-server",
  "--listen",
  "stdio://",
  "-c",
  "features.multi_agent_v2=true",
];
const POST_PARENT_OBSERVATION_MS = 45_000;
const MIN_POST_RELEASE_WORKER_CALLS = 1;

type RelayHookCall = {
  atMs: number;
  toolName: string;
};

const FAIL_CLOSED_MARKERS = [
  "native hook relay unavailable",
  "native hook relay not found",
  "blocked by pretooluse",
] as const;

afterEach(() => {
  clearCodexNativeHookRelayOwners();
  resetGlobalHookRunner();
  vi.unstubAllEnvs();
});

describeLive("Codex native hook relay worker lifetime", () => {
  it("keeps a detached worker's tool calls reaching OpenClaw policy after parent release", async () => {
    await withTempDir("openclaw-codex-native-hook-relay-", async (rootInput) => {
      const root = await fs.realpath(rootInput);
      const workspace = path.join(root, "workspace");
      const agentDir = path.join(root, "agent");
      await fs.mkdir(workspace, { recursive: true });
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const codexHome = await stageCodexHomeCopy(root);
      vi.stubEnv("CODEX_HOME", codexHome);

      const pluginConfig = { appServer: { homeScope: "user", args: CODEX_MULTI_AGENT_ARGS } };
      const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig, env: {} });
      const client = await createIsolatedCodexAppServerClient({
        startOptions: runtime.start,
        agentDir,
        authProfileId: null,
        timeoutMs: 120_000,
      });
      try {
        const listed = await client.request<CodexModelListResponse>(
          "model/list",
          { limit: 100, cursor: null, includeHidden: false },
          { timeoutMs: 60_000 },
        );
        const modelId =
          listed.data.find((model) => model.isDefault)?.model ?? listed.data[0]?.model;
        if (!modelId) {
          throw new Error("Codex model/list returned no models");
        }

        const relayHookCalls: RelayHookCall[] = [];
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              handler: async (event, ctx) => {
                const hookContext = ctx as PluginHookToolContext;
                relayHookCalls.push({
                  atMs: Date.now(),
                  toolName: hookContext.toolName ?? readEventToolName(event),
                });
                return undefined;
              },
            },
          ]),
        );

        const agentEvents: Array<{ atMs: number; stream: string; data: Record<string, unknown> }> =
          [];
        const params = {
          sessionId: "native-hook-relay-session",
          sessionKey: "agent:native-hook-relay:main",
          sessionFile: path.join(root, "session.jsonl"),
          workspaceDir: workspace,
          cwd: workspace,
          agentDir,
          provider: "codex",
          modelId,
          model: {
            id: modelId,
            name: modelId,
            provider: "codex",
            api: "openai-chatgpt-responses",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8_000,
            compat: { supportsTools: false },
          },
          prompt: [
            "You must use the Codex native spawn_agent tool exactly once before replying.",
            "If spawn_agent is not directly listed, load it with tool_search first.",
            "Give the spawned agent this exact task: 'Using your shell tool, run these commands one at a time in order: date, sleep 10, date, sleep 10, date, sleep 10, date, sleep 10, date. Then reply with exactly WORKER-DONE.'",
            "Do NOT wait for the spawned agent and do NOT call wait_agent.",
            "Immediately after spawn_agent returns, reply with exactly PARENT-SPAWNED.",
          ].join("\n"),
          runId: "native-hook-relay-run",
          contextTokenBudget: 150_000,
          contextWindowInfo: {
            tokens: 150_000,
            referenceTokens: 200_000,
            source: "agentContextTokens",
          },
          thinkLevel: "medium",
          disableTools: false,
          config: { tools: { web: { search: { enabled: false } } } },
          timeoutMs: 180_000,
          trigger: "user",
          oneShotCliRun: false,
          senderIsOwner: true,
          authStorage: {},
          authProfileStore: { version: 1, profiles: {} },
          modelRegistry: {},
          onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
            agentEvents.push({ atMs: Date.now(), ...event });
          },
        } as unknown as EmbeddedRunAttemptParams;

        const result = await runCodexAppServerAttempt(params, {
          bindingStore: createCodexTestBindingStore(),
          pluginConfig,
          nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
          clientFactory: async () => client,
        });
        const parentReleasedAtMs = Date.now();
        expect(result.terminal.kind, JSON.stringify(result.terminal)).toBe("ok");
        const parentCallCount = relayHookCalls.length;
        expect(
          parentCallCount,
          `parent turn relayed no native tool call to OpenClaw policy; tools=${JSON.stringify(
            relayHookCalls.map((call) => call.toolName),
          )}`,
        ).toBeGreaterThan(0);

        await delay(POST_PARENT_OBSERVATION_MS);
        const postReleaseCalls = relayHookCalls
          .slice(parentCallCount)
          .filter((call) => call.atMs > parentReleasedAtMs + 15_000);
        expect(
          postReleaseCalls.length,
          `worker tool calls after parent release + 15s; timeline=${JSON.stringify(
            relayHookCalls.map((call) => ({
              atMs: call.atMs - parentReleasedAtMs,
              toolName: call.toolName,
            })),
          )}`,
        ).toBeGreaterThanOrEqual(MIN_POST_RELEASE_WORKER_CALLS);
        const failClosedEvents = agentEvents.flatMap((event) => {
          const serialized = JSON.stringify(event.data).toLowerCase();
          const marker = FAIL_CLOSED_MARKERS.find((text) => serialized.includes(text));
          return marker ? [{ atMsFromParentRelease: event.atMs - parentReleasedAtMs, marker }] : [];
        });
        expect(
          failClosedEvents.filter((event) => event.atMsFromParentRelease > 0),
          `post-release fail-closed events; all=${JSON.stringify(failClosedEvents)}`,
        ).toEqual([]);

        console.info(
          `[native-hook-relay-live] parentCalls=${parentCallCount} failClosed=${JSON.stringify(
            failClosedEvents,
          )} timeline=${JSON.stringify(
            relayHookCalls.map((call) => ({
              atMsFromParentRelease: call.atMs - parentReleasedAtMs,
              toolName: call.toolName,
            })),
          )}`,
        );

        const releaseDeadline = Date.now() + 240_000;
        while (codexNativeHookRelayOwnerCount() > 0 && Date.now() < releaseDeadline) {
          await delay(2_000);
        }
        expect(codexNativeHookRelayOwnerCount()).toBe(0);
      } finally {
        await client.closeAndWait();
      }
    });
  }, 900_000);
});

async function stageCodexHomeCopy(root: string): Promise<string> {
  const source = path.join(os.homedir(), ".codex");
  const target = path.join(root, "codex-home");
  await fs.mkdir(target, { recursive: true });
  const auth = await fs.readFile(path.join(source, "auth.json"), "utf8").catch(() => undefined);
  if (!auth) {
    throw new Error("live Codex auth requires ~/.codex/auth.json from `codex login`");
  }
  await fs.writeFile(path.join(target, "auth.json"), auth, { mode: 0o600 });
  return target;
}

function readEventToolName(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "unknown";
  }
  const toolName = (event as { toolName?: unknown }).toolName;
  return typeof toolName === "string" ? toolName : "unknown";
}
