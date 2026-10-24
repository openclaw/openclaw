import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-codex-hook-context-proof";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/codex-hook-context-proof-plugin",
);
const CONVERSATION = { id: "authenticated-team-room", kind: "direct" as const };

const HOOKS = ["beforePromptBuild", "beforeCompaction", "afterCompaction"] as const;
type HookCaptures = Record<(typeof HOOKS)[number], (typeof authenticatedContext)[]>;

function withFixturePlugin(config: OpenClawConfig): OpenClawConfig {
  const plugins = (config.plugins ??= {});
  plugins.enabled = true;
  plugins.allow = [...new Set([...(plugins.allow ?? []), PLUGIN_ID])];
  const load = (plugins.load ??= {});
  load.paths = [...new Set([...(load.paths ?? []), PLUGIN_DIR])];
  (plugins.entries ??= {})[PLUGIN_ID] = {
    enabled: true,
    hooks: { allowConversationAccess: true, allowPromptInjection: true },
  };
  return config;
}

const authenticatedContext = {
  accountId: "default",
  senderId: "ahmad",
  chatId: CONVERSATION.id,
  channel: "qa-channel",
  sessionKey: "agent:qa:main",
  channelContext: { sender: { id: "ahmad" }, chat: { id: CONVERSATION.id } },
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it("preserves admitted qa-channel identity through prompt and native compaction hooks", async () => {
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const bus = await startQaBusServer({ state });
  cleanups.push(() => bus.stop());

  const mock = await startQaMockOpenAiServer();
  cleanups.push(() => mock.stop());

  const gatewayOwner = createQaGatewayChild();
  cleanups.push(async () => {
    expect((await gatewayOwner.stop()).errors).toEqual([]);
  });
  const gateway = await gatewayOwner.start({
    repoRoot: REPO_ROOT,
    useRepoCli: true,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    forcedRuntime: "codex",
    codexMockAutoCompactTokenLimit: 1,
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    mutateConfig: withFixturePlugin,
  });
  await transport.waitReady({ gateway });

  async function sendTurn(text: string) {
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: "ahmad",
      senderName: "Ahmad",
      text,
    });
    await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex,
      timeoutMs: 120_000,
    });
  }
  await sendTurn(
    `Preserve this authenticated sender while compacting. ${"context ".repeat(8_000)}`,
  );
  await sendTurn("Continue after preserving the authenticated sender.");

  const response = await fetch(`${gateway.baseUrl}/qa/codex-hook-context-proof`, {
    headers: { Authorization: `Bearer ${gateway.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  const captures = (await response.json()) as HookCaptures;
  for (const hook of HOOKS) {
    expect(captures[hook].at(-1), hook).toMatchObject(authenticatedContext);
  }
  const verdictPath = process.env.OPENCLAW_QA_VERDICT_PATH?.trim();
  if (verdictPath) {
    await fs.mkdir(path.dirname(verdictPath), { recursive: true });
    const verdict = {
      scenario: "codex-authenticated-hook-context",
      passed: true,
      channel: "qa-channel",
      provider: "mock-openai",
      runtime: "codex",
      gateway: "ephemeral-child-process",
      captures: Object.fromEntries(HOOKS.map((hook) => [hook, captures[hook].length])),
      authenticatedContext: captures.afterCompaction.at(-1),
    };
    await fs.writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }
}, 240_000);
