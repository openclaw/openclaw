import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeChannelBridge, type ClaudeChannelBridge } from "./local-session-bridge.js";

// Pairing state machine proof over the real socket: channel processes say hello,
// hook processes name sessions, and a start must pair at most one channel.
const waitFor = <T>(probe: () => T | Promise<T>) =>
  vi.waitFor(probe, { timeout: 5_000, interval: 10 });

describe("Claude channel bridge pairing", () => {
  let stateDir: string;
  let endpoint: string;
  let bridge: ClaudeChannelBridge;
  const sockets: net.Socket[] = [];
  const pairings: Array<[string, boolean]> = [];

  beforeEach(async () => {
    // Unix socket paths are capped at ~104 bytes; keep the temp root short.
    stateDir = path.join(
      process.platform === "win32" ? os.tmpdir() : "/tmp",
      `oc-${randomBytes(4).toString("hex")}`,
    );
    await fs.mkdir(stateDir, { recursive: true });
    endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\openclaw-claude-test-${randomBytes(4).toString("hex")}`
        : path.join(stateDir, "claude-channel.sock");
    pairings.length = 0;
    bridge = await createClaudeChannelBridge({
      endpoint,
      events: {
        onPairingChange: (sessionId, connected) => pairings.push([sessionId, connected]),
        onHook: () => {},
      },
    });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await bridge.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function connectFrame(frame: Record<string, unknown>): Promise<net.Socket> {
    const socket = net.createConnection(endpoint);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify(frame)}\n`);
    return socket;
  }

  const hello = (cwd: string) => connectFrame({ type: "hello", cwd });
  const hook = async (event: string, sessionId: string, cwd: string) => {
    const socket = await connectFrame({ type: "hook", event, sessionId, cwd, ancestorPids: [] });
    socket.end();
  };

  it("does not let a start that already paired capture a later channel in the same cwd", async () => {
    const cwd = "/repo/shared";
    // Two unpaired channels make the cwd-only start ambiguous, so it is retained.
    const first = await hello(cwd);
    const second = await hello(cwd);
    await hook("SessionStart", "session-a", cwd);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.isConnected("session-a")).toBe(false);
    // One channel leaves; the next hook pairs the remaining one with the session.
    second.destroy();
    await hook("UserPromptSubmit", "session-a", cwd);
    await waitFor(() => expect(bridge.isConnected("session-a")).toBe(true));
    // A fresh channel in the same cwd must stay unpaired instead of stealing session-a.
    await hello(cwd);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pairings).toEqual([["session-a", true]]);
    expect(bridge.isConnected("session-a")).toBe(true);
    first.destroy();
    await waitFor(() => expect(bridge.isConnected("session-a")).toBe(false));
  });

  it("drops a retained start once its session ends", async () => {
    const cwd = "/repo/ended";
    await hello(cwd);
    await hello(cwd);
    await hook("SessionStart", "session-b", cwd);
    await hook("SessionEnd", "session-b", cwd);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await hello(cwd);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pairings).toEqual([]);
  });
});
