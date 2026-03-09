import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldInjectBootstrapContext } from "./session-manager-init.js";

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
});
