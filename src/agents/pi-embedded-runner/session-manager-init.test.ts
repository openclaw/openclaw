import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareSessionManagerForRun,
  shouldInjectBootstrapContext,
} from "./session-manager-init.js";

const tempRoots: string[] = [];

async function makeSessionFile(content?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-bootstrap-"));
  tempRoots.push(root);
  const sessionFile = path.join(root, "session.jsonl");
  if (content !== undefined) {
    await fs.writeFile(sessionFile, content, "utf-8");
  }
  return sessionFile;
}

async function makeSessionDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-bootstrap-dir-"));
  tempRoots.push(root);
  return path.join(root, "session-dir");
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("shouldInjectBootstrapContext", () => {
  it("injects bootstrap context when the transcript does not exist yet", async () => {
    const sessionFile = await makeSessionFile();
    expect(await shouldInjectBootstrapContext(sessionFile)).toBe(true);
  });

  it("injects bootstrap context when the transcript only has a session header", async () => {
    const sessionFile = await makeSessionFile(
      `${JSON.stringify({ type: "session", id: "sess-1", cwd: "/tmp" })}\n`,
    );
    expect(await shouldInjectBootstrapContext(sessionFile)).toBe(true);
  });

  it("keeps bootstrap context when the transcript only has pre-assistant messages", async () => {
    const sessionFile = await makeSessionFile(
      [
        JSON.stringify({ type: "session", id: "sess-1", cwd: "/tmp" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n"),
    );
    expect(await shouldInjectBootstrapContext(sessionFile)).toBe(true);
  });

  it("skips bootstrap context after the transcript already has an assistant message", async () => {
    const sessionFile = await makeSessionFile(
      [
        JSON.stringify({ type: "session", id: "sess-1", cwd: "/tmp" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
      ].join("\n"),
    );
    expect(await shouldInjectBootstrapContext(sessionFile)).toBe(false);
  });

  it("falls back to injecting bootstrap context when the transcript is malformed", async () => {
    const sessionFile = await makeSessionFile("{not-json}\n");
    expect(await shouldInjectBootstrapContext(sessionFile)).toBe(true);
  });

  it("falls back to injecting bootstrap context when transcript streaming fails", async () => {
    const sessionDir = await makeSessionDirectory();
    await fs.mkdir(sessionDir);

    expect(await shouldInjectBootstrapContext(sessionDir)).toBe(true);
  });

  it("falls back to injecting bootstrap context when the first assistant entry is beyond the scan cap", async () => {
    const oversizedUserContent = "x".repeat(300_000);
    const sessionFile = await makeSessionFile(
      [
        JSON.stringify({ type: "session", id: "sess-1", cwd: "/tmp" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: oversizedUserContent },
        }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
      ].join("\n"),
    );
    expect(await shouldInjectBootstrapContext(sessionFile)).toBe(true);
  });
});

describe("prepareSessionManagerForRun", () => {
  it("updates in-memory header metadata for fresh session files", async () => {
    const sessionFile = await makeSessionFile();
    const header = { type: "session" as const };
    const sessionManager = {
      sessionId: "old-session",
      flushed: false,
      fileEntries: [header],
    };

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: false,
      sessionId: "sess-1",
      cwd: "/workspace",
    });

    expect(header).toEqual({ type: "session", id: "sess-1", cwd: "/workspace" });
    expect(sessionManager.sessionId).toBe("sess-1");
  });

  it("resets pre-created session files that do not have an assistant message yet", async () => {
    const sessionFile = await makeSessionFile("existing transcript");
    const header = { type: "session" as const, id: "sess-1", cwd: "/workspace" };
    const sessionManager = {
      sessionId: "sess-1",
      flushed: true,
      fileEntries: [
        header,
        { type: "message" as const, message: { role: "user", content: "hello" } },
      ],
      byId: new Map([["msg-1", { id: "msg-1" }]]),
      labelsById: new Map([["last", { id: "msg-1" }]]),
      leafId: "msg-1",
    };

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "sess-1",
      cwd: "/workspace",
    });

    expect(await fs.readFile(sessionFile, "utf-8")).toBe("");
    expect(sessionManager.fileEntries).toEqual([header]);
    expect(sessionManager.byId.size).toBe(0);
    expect(sessionManager.labelsById.size).toBe(0);
    expect(sessionManager.leafId).toBeNull();
    expect(sessionManager.flushed).toBe(false);
  });

  it("keeps existing session state once an assistant message has already been persisted", async () => {
    const sessionFile = await makeSessionFile("existing transcript");
    const header = { type: "session" as const, id: "sess-1", cwd: "/workspace" };
    const byId = new Map([["msg-1", { id: "msg-1" }]]);
    const labelsById = new Map([["last", { id: "msg-1" }]]);
    const sessionManager = {
      sessionId: "sess-1",
      flushed: true,
      fileEntries: [
        header,
        { type: "message" as const, message: { role: "assistant", content: "hi" } },
      ],
      byId,
      labelsById,
      leafId: "msg-1",
    };

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "sess-1",
      cwd: "/workspace",
    });

    expect(await fs.readFile(sessionFile, "utf-8")).toBe("existing transcript");
    expect(sessionManager.fileEntries).toHaveLength(2);
    expect(sessionManager.byId).toBe(byId);
    expect(sessionManager.labelsById).toBe(labelsById);
    expect(sessionManager.leafId).toBe("msg-1");
    expect(sessionManager.flushed).toBe(true);
  });
});
