import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INBOUND_TURN_FILE_ENV_KEY,
  resolveInboundTurnFilePath,
  writeInboundTurnFile,
} from "./inbound-turn-file.js";

describe("resolveInboundTurnFilePath", () => {
  it("derives a stable session-scoped path under the state dir", () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" } as NodeJS.ProcessEnv;
    const p = resolveInboundTurnFilePath({ sessionId: "agent:main:whatsapp:direct:peer", env });
    expect(p).toBe(
      path.join(
        "/tmp/openclaw-state",
        "tmp",
        "inbound-turn",
        "agent_main_whatsapp_direct_peer.json",
      ),
    );
    // Stable across calls — the env var is set once at spawn, contents change per turn.
    expect(resolveInboundTurnFilePath({ sessionId: "agent:main:whatsapp:direct:peer", env })).toBe(
      p,
    );
  });

  it("sanitizes path-unsafe characters out of the session id", () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" } as NodeJS.ProcessEnv;
    expect(resolveInboundTurnFilePath({ sessionId: "a/b:c d", env })).toBe(
      path.join("/tmp/openclaw-state", "tmp", "inbound-turn", "a_b_c_d.json"),
    );
  });

  it("falls back to 'default' when the session id is empty", () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" } as NodeJS.ProcessEnv;
    expect(resolveInboundTurnFilePath({ sessionId: "", env })).toBe(
      path.join("/tmp/openclaw-state", "tmp", "inbound-turn", "default.json"),
    );
  });
});

describe("writeInboundTurnFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-inbound-turn-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the current turn identifiers as schema-tagged JSON, creating parent dirs", () => {
    const filePath = path.join(dir, "tmp", "inbound-turn", "session.json");
    writeInboundTurnFile(
      filePath,
      {
        messageId: "AAA",
        senderId: "15551234567@s.whatsapp.net",
        senderE164: "+15551234567",
        chatId: "whatsapp:15551234567@s.whatsapp.net",
        replyToId: "wamid.PARENT",
        channel: "whatsapp",
        provider: "whatsapp",
      },
      { runId: "run-123" },
    );

    const payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      schema: "openclaw.inbound_turn.v1",
      messageId: "AAA",
      senderId: "15551234567@s.whatsapp.net",
      senderE164: "+15551234567",
      chatId: "whatsapp:15551234567@s.whatsapp.net",
      replyToId: "wamid.PARENT",
      channel: "whatsapp",
      provider: "whatsapp",
      runId: "run-123",
    });
    expect(typeof payload["writtenAt"]).toBe("number");
  });

  it("overwrites the file in place so each turn sees fresh values", () => {
    const filePath = path.join(dir, "session.json");
    writeInboundTurnFile(filePath, { messageId: "first", channel: "whatsapp" });
    writeInboundTurnFile(filePath, { messageId: "second", channel: "whatsapp" });
    const payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(payload["messageId"]).toBe("second");
  });

  it("omits runId when no run metadata is supplied", () => {
    const filePath = path.join(dir, "session.json");
    writeInboundTurnFile(filePath, { messageId: "AAA", channel: "whatsapp" });
    const payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("runId");
  });
});

describe("INBOUND_TURN_FILE_ENV_KEY", () => {
  it("is the documented env var name", () => {
    expect(INBOUND_TURN_FILE_ENV_KEY).toBe("OPENCLAW_INBOUND_TURN_FILE");
  });
});
