import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Boundary proof for the shipped Claude channel artifacts: the real MCP server
// process speaks the channel contract to a real MCP client, and the hook script
// reports its session to the bridge socket.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClaudeChannelBridge, type ClaudeChannelBridge } from "./local-session-bridge.js";

const SESSION_ID = "12345678-aaaa-4bbb-8ccc-1234567890ab";
// The shipped artifacts live next to the plugin source; the test runs the real files.
const channelArtifact = (fileName: string) =>
  fileURLToPath(new URL(`./claude-channel/${fileName}`, import.meta.url));
const channelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});

const waitFor = <T>(probe: () => T | Promise<T>) =>
  vi.waitFor(probe, { timeout: 8_000, interval: 25 });

describe("Claude channel artifacts", () => {
  let endpoint: string;
  let stateDir: string;
  let cwd: string;
  let bridge: ClaudeChannelBridge;
  const pairings: Array<[string, boolean]> = [];
  const hooks: string[] = [];
  let client: Client | undefined;

  beforeEach(async () => {
    // The artifacts derive the socket from OPENCLAW_STATE_DIR, exactly as installed.
    // Unix socket paths are capped at ~104 bytes; the runner's nested tmpdir overflows it.
    stateDir = path.join(
      process.platform === "win32" ? os.tmpdir() : "/tmp",
      `oc-${randomBytes(4).toString("hex")}`,
    );
    await fs.mkdir(path.join(stateDir, "node"), { recursive: true });
    endpoint = path.join(stateDir, "node", "claude-channel.sock");
    cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-channel-")));
    pairings.length = 0;
    hooks.length = 0;
    bridge = await createClaudeChannelBridge({
      endpoint,
      events: {
        onPairingChange: (sessionId, connected) => pairings.push([sessionId, connected]),
        onHook: (event) => hooks.push(event.name),
      },
    });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await bridge.close();
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function runHook(event: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [channelArtifact("openclaw-channel-hook.mjs")], {
        cwd,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        stdio: ["pipe", "ignore", "inherit"],
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code));
      child.stdin.end(
        JSON.stringify({
          session_id: SESSION_ID,
          cwd,
          hook_event_name: event,
          transcript_path: path.join(cwd, "t.jsonl"),
        }),
      );
    });
  }

  it("declares the channel capability, pairs through the hook, and delivers team input", async () => {
    const received: Array<{ content: string; meta: Record<string, string> }> = [];
    client = new Client({ name: "claude-code-test", version: "0.0.0" });
    client.setNotificationHandler(channelNotificationSchema, async ({ params }) => {
      received.push(params);
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [channelArtifact("openclaw-channel-server.mjs")],
        cwd,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        stderr: "inherit",
      }),
    );
    expect(client.getServerCapabilities()).toMatchObject({
      experimental: { "claude/channel": {} },
      tools: {},
    });
    expect(client.getInstructions()).toContain('<channel source="openclaw"');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["reply"]);

    expect(await runHook("SessionStart")).toBe(0);
    await waitFor(() => expect(bridge.isConnected(SESSION_ID)).toBe(true));
    expect(pairings).toEqual([[SESSION_ID, true]]);
    expect(hooks).toEqual(["SessionStart"]);

    const delivery = await bridge.sendInput({
      sessionId: SESSION_ID,
      inputId: "in-1",
      content: "[Ann via OpenClaw team · message in-1]\nhello",
      meta: { sender: "Ann", openclaw_input_id: "in-1" },
    });
    expect(delivery).toEqual({ ok: true });
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      content: "[Ann via OpenClaw team · message in-1]\nhello",
      meta: { sender: "Ann", openclaw_input_id: "in-1" },
    });

    const reply = await client.callTool({
      name: "reply",
      arguments: { text: "on it", openclaw_input_id: "in-1" },
    });
    expect(reply.content).toEqual([{ type: "text", text: "sent" }]);

    expect(await runHook("SessionEnd")).toBe(0);
    await waitFor(() => expect(bridge.isConnected(SESSION_ID)).toBe(false));
  });

  it("hook exits cleanly when no bridge is listening", async () => {
    await bridge.close();
    expect(await runHook("Stop")).toBe(0);
  });
});
