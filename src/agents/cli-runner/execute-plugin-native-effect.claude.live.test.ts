/**
 * Live final-effect proof for the native tool permission chain.
 *
 * Drives the real installed Claude Code client through the production
 * Anthropic stdio transport and the production host permission handler
 * (the adapted asynchronous chain), against a loopback-only mock Messages
 * SSE server with a throwaway fake API key. No real provider account,
 * paid inference, or real user workspace is used.
 *
 * Opt in with:
 *   OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CLAUDE_NATIVE=1 \
 *     pnpm test:live -- src/agents/cli-runner/execute-plugin-native-effect.claude.live.test.ts
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CLAUDE_NATIVE === "1";
const CLAUDE_BIN = process.env.OPENCLAW_LIVE_CLAUDE_BIN?.trim() || "claude";

const roots: string[] = [];
const servers: http.Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function resolveClaudeBinary(): string {
  const which = spawnSync("which", [CLAUDE_BIN], { encoding: "utf8" });
  return (which.stdout ?? "").trim() || CLAUDE_BIN;
}

type SseEvent = string;

function sseEvent(name: string, data: unknown): SseEvent {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toolUseWriteEvents(target: string, content: string): SseEvent[] {
  const input = { file_path: target, content };
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_native_proof",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_native_proof", name: "Write", input: {} },
    }),
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(input),
      },
    })}\n\n`,
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 6 },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ];
}

function finalTextEvents(): SseEvent[] {
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_native_proof_final",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "tool handling complete" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ];
}

function startMockMessagesServer(scripts: SseEvent[][]): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname.endsWith("/v1/messages")) {
        const events = scripts.shift() ?? finalTextEvents();
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        for (const event of events) {
          res.write(event);
        }
        res.end();
        return;
      }
      if (url.pathname.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      expect(address && typeof address === "object", "mock server must listen").toBe(true);
      resolve(`http://127.0.0.1:${(address as { port: number }).port}`);
    });
  });
}

async function runNativeWriteTurn(params: {
  name: string;
  config: OpenClawConfig;
  sessionEntry?: SessionEntry;
  targetRoot: "workspace" | "outside";
  expectAllowed: boolean;
}): Promise<{ fileExists: boolean; fileBytes: string; stdout: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-native-live-proof-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const home = path.join(root, "home");
  const configDir = path.join(root, "claude-config");
  const tmp = path.join(root, "tmp");
  for (const dir of [workspace, outside, home, configDir, tmp]) {
    await mkdir(dir, { recursive: true });
  }
  await rm(path.join(configDir, ".claude.json"), { force: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    path.join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, hasTrustDialogAccepted: true }),
  );

  const target = path.join(
    params.targetRoot === "workspace" ? path.join(workspace, "nested") : outside,
    "native-effect.txt",
  );
  await mkdir(path.dirname(target), { recursive: true });

  const baseUrl = await startMockMessagesServer([
    toolUseWriteEvents(target, "native effect\n"),
    finalTextEvents(),
  ]);

  const backend = resolveCliBackendConfig("claude-cli");
  expect(backend, "claude-cli backend must be registered").not.toBeNull();
  const prepared = await backend!.prepareExecution?.({
    provider: "claude-cli",
    modelId: "claude-sonnet-4-6",
    workspaceDir: workspace,
    executionMode: "agent",
  });
  expect(prepared?.execute, "backend must expose its production transport").toBeTypeOf("function");

  const runId = `native-live-${params.name}-${Date.now()}`;
  const admission = prepareSystemAgentRunAdmission(params.config, runId, "main", "live-proof");
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    model: "claude-sonnet-4-6",
    runId,
    sessionKey: "agent:main:native-live-proof",
    agentId: "main",
    config: params.config,
    workspaceDir: workspace,
    sessionEntry: params.sessionEntry,
    prompt: "Write the file as instructed.",
    systemPrompt: "Follow the user's file instruction exactly once.",
    timeoutMs: 240_000,
    executionMode: "agent",
  });
  context.params.admittedRunContext = await admission.admit("plugin-harness");

  const stdoutChunks: string[] = [];
  try {
    const exit = await executePluginOwnedProcess({
      context,
      execute: prepared!.execute!,
      executionCommand: resolveClaudeBinary(),
      executionArgs: [...backend!.config.args],
      env: {
        ...(prepared?.env ?? {}),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: tmp,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: "sk-ant-live-proof-fake",
        ANTHROPIC_AUTH_TOKEN: "",
        NO_COLOR: "1",
        CLAUDE_CODE_DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      },
      prompt: context.params.prompt,
      useResume: false,
      sessionId: randomUUID(),
      noOutputTimeoutMs: 120_000,
      consumeStdout: (chunk) => stdoutChunks.push(chunk),
    });
    expect(exit.reason).toBe("exit");
  } finally {
    admission.close();
  }

  const stdout = stdoutChunks.join("");
  let fileBytes = "";
  try {
    fileBytes = await readFile(target, "utf8");
  } catch {
    // absent is a valid final effect
  }
  return { fileExists: fileBytes.length > 0, fileBytes, stdout };
}

describe.skipIf(!LIVE)("claude cli native final-effect permission chain", () => {
  it(
    "allows a policy-permitted native Write inside the execution workspace",
    { timeout: 300_000 },
    async () => {
      const proof = await runNativeWriteTurn({
        name: "allowed",
        config: {
          tools: {
            allow: ["write"],
            profile: "full",
            exec: { security: "full", ask: "off" },
          },
        },
        targetRoot: "workspace",
        expectAllowed: true,
      });
      expect(proof.fileExists).toBe(true);
      expect(proof.fileBytes).toBe("native effect\n");
    },
  );

  it(
    "denies the native Write outside the workspace before native I/O under workspaceOnly",
    { timeout: 300_000 },
    async () => {
      const proof = await runNativeWriteTurn({
        name: "denied-outside",
        config: {
          tools: {
            allow: ["write"],
            profile: "full",
            fs: { workspaceOnly: true },
            exec: { security: "full", ask: "off" },
          },
        },
        targetRoot: "outside",
        expectAllowed: false,
      });
      expect(proof.fileExists).toBe(false);
      expect(proof.stdout).toContain("Path escapes sandbox root");
    },
  );

  it(
    "keeps an explicit full session unrestricted by configured workspaceOnly",
    { timeout: 300_000 },
    async () => {
      const proof = await runNativeWriteTurn({
        name: "explicit-full-session",
        config: {
          tools: {
            allow: ["write"],
            profile: "full",
            fs: { workspaceOnly: true },
            exec: { security: "full", ask: "off" },
          },
        },
        sessionEntry: {
          sessionId: "native-live-proof-full-session",
          updatedAt: 1,
          permissionMode: "full",
        } as SessionEntry,
        targetRoot: "outside",
        expectAllowed: true,
      });
      expect(proof.fileExists).toBe(true);
      expect(proof.fileBytes).toBe("native effect\n");
    },
  );
});
