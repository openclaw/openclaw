// Product proof: a real Gateway turn must bind before_prompt_build to the admitted
// request on both the embedded runtime and the CLI backend process, so a plugin can
// identify the current input and its stable admission identity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-prompt-build-current-input-probe";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/prompt-build-current-input-probe",
);
const CONVERSATION = { id: "prompt-build-current-input", kind: "direct" as const };
const USER_TEXT = "PROMPT_BUILD_CURRENT_INPUT_MARKER";
const CLI_MODEL = "claude-cli/claude-opus-5";

// Minimal claude-stdio protocol: initialize handshake, one user turn, immediate result.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const dir = process.env.FAKE_CLAUDE_DIR;
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("2.1.300 (Claude Code)\n"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "qa@example.com" }) + "\n");
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sessionIdx = argv.indexOf("--session-id");
const sessionId = sessionIdx >= 0 ? argv[sessionIdx + 1] : require("node:crypto").randomUUID();
let resultEmitted = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { if (resultEmitted) process.exit(0); });
}
setInterval(() => {}, 60_000);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "control_request" && message.request && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: [] } } });
    return;
  }
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type === "user") {
    fs.writeFileSync(path.join(dir, "turn-started.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    send({ type: "system", subtype: "init", session_id: sessionId, model: "claude-opus-5", tools: [], cwd: process.cwd() });
    const text = "fake-claude reply " + sessionId;
    send({ type: "assistant", message: { id: "msg_1", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] }, session_id: sessionId });
    send({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, duration_ms: 5, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } });
    resultEmitted = true;
    fs.writeFileSync(path.join(dir, "turn-finished.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return;
  }
});
`;

type CapturedEvent = {
  keys: string[];
  hasCurrentUserMessage: boolean;
  currentUserMessage: string | null;
  hasCurrentUserMessageId: boolean;
  currentUserMessageId: string | null;
  prompt: string | null;
  trigger: string | null;
};

function withProbePlugin(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), PLUGIN_DIR])],
      },
      entries: {
        ...config.plugins?.entries,
        [PLUGIN_ID]: {
          enabled: true,
          hooks: { allowConversationAccess: true, allowPromptInjection: true },
        },
      },
    },
  };
}

/** Routes the QA agent to the bundled Claude CLI backend so a real CLI process runs. */
function withCliBackendConfig(config: OpenClawConfig): OpenClawConfig {
  const probeConfig = withProbePlugin(config);
  const defaults = probeConfig.agents?.defaults;
  return {
    ...probeConfig,
    plugins: {
      ...probeConfig.plugins,
      allow: [...new Set([...(probeConfig.plugins?.allow ?? []), "anthropic"])],
      entries: {
        ...probeConfig.plugins?.entries,
        anthropic: { enabled: true, subagent: { allowModelOverride: true } },
      },
    },
    agents: {
      ...probeConfig.agents,
      defaults: {
        ...defaults,
        model: CLI_MODEL,
        models: { ...defaults?.models, [CLI_MODEL]: {} },
        modelPolicy: {
          allow: [...(defaults?.modelPolicy?.allow ?? []), CLI_MODEL],
        },
      },
      entries: {
        ...probeConfig.agents?.entries,
        qa: { ...probeConfig.agents?.entries?.qa, model: CLI_MODEL },
      },
    },
  };
}

async function readProbeCaptures(gateway: {
  baseUrl: string;
  token: string;
}): Promise<CapturedEvent[]> {
  const response = await fetch(`${gateway.baseUrl}/qa/prompt-build-current-input`, {
    headers: { Authorization: `Bearer ${gateway.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  const captures = (await response.json()) as { beforePromptBuild: CapturedEvent[] };
  return captures.beforePromptBuild;
}

describe("prompt-build current input on real runtimes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  async function startGateway(
    mutateConfig: (config: OpenClawConfig) => OpenClawConfig,
    configureEnv?: () => void,
  ) {
    configureEnv?.();
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());

    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());

    const gatewayOwner = createQaGatewayChild();
    cleanups.push(async () => {
      await gatewayOwner.stop();
    });
    const gateway = await gatewayOwner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig,
    });
    await transport.waitReady({ gateway });
    return { gateway, state, transport };
  }

  it(
    "binds the admitted request onto the embedded prompt boundary event",
    { timeout: 300_000 },
    async () => {
      const { gateway, state, transport } = await startGateway(withProbePlugin);

      const outboundStartIndex = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound").length;
      await transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: "probe-user",
        text: USER_TEXT,
      });
      await transport.waitForOutbound({
        conversation: CONVERSATION,
        sinceIndex: outboundStartIndex,
        timeoutMs: 180_000,
      });

      const captured = (await readProbeCaptures(gateway)).at(-1);
      expect(captured).toBeDefined();
      expect(captured).toMatchObject({
        hasCurrentUserMessage: true,
        hasCurrentUserMessageId: true,
        currentUserMessage: USER_TEXT,
        trigger: "user",
      });
      expect(captured?.keys).toEqual([
        "currentUserMessage",
        "currentUserMessageId",
        "messages",
        "prompt",
      ]);
      expect(captured?.currentUserMessageId).toEqual(expect.any(String));
      expect(captured?.currentUserMessageId?.length).toBeGreaterThan(0);
    },
  );

  it(
    "binds the admitted request onto the CLI backend prompt boundary event",
    { timeout: 300_000 },
    async () => {
      const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-fake-claude-"));
      // Registered before the Gateway so it runs after Gateway shutdown, when the
      // CLI child has released the executable.
      cleanups.push(async () => {
        fs.rmSync(fakeDir, { recursive: true, force: true });
      });
      const fakeBin = path.join(fakeDir, "claude");
      fs.writeFileSync(fakeBin, FAKE_CLAUDE, { mode: 0o755 });
      const { gateway, state, transport } = await startGateway(withCliBackendConfig, () => {
        vi.stubEnv("PATH", `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`);
        vi.stubEnv("FAKE_CLAUDE_DIR", fakeDir);
      });

      const outboundStartIndex = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound").length;
      await transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: "probe-user",
        text: USER_TEXT,
      });
      await transport.waitForOutbound({
        conversation: CONVERSATION,
        sinceIndex: outboundStartIndex,
        timeoutMs: 180_000,
      });
      // The CLI backend path is only covered if a real child process ran the turn:
      // the fake CLI writes these markers and its reply reaches the channel.
      const outbound = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound")
        .slice(outboundStartIndex);
      const cliObservation = {
        turnStarted: fs.existsSync(path.join(fakeDir, "turn-started.json")),
        turnFinished: fs.existsSync(path.join(fakeDir, "turn-finished.json")),
        reply: outbound.at(-1)?.text ?? null,
      };
      process.stdout.write(`CLI_PROCESS_TRACE ${JSON.stringify(cliObservation)}\n`);
      expect(cliObservation.turnStarted).toBe(true);
      expect(cliObservation.turnFinished).toBe(true);
      expect(cliObservation.reply).toMatch(/^fake-claude reply /);

      const captured = (await readProbeCaptures(gateway)).at(-1);
      expect(captured).toBeDefined();
      expect(captured).toMatchObject({
        hasCurrentUserMessage: true,
        hasCurrentUserMessageId: true,
        currentUserMessage: USER_TEXT,
        trigger: "user",
      });
      expect(captured?.currentUserMessageId).toEqual(expect.any(String));
      expect(captured?.currentUserMessageId?.length).toBeGreaterThan(0);
    },
  );
});
