import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../../src/plugins/hooks.test-helpers.js";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetGlobalHookRunner();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-transcript-"));
  tempDirs.push(dir);
  return path.join(dir, "session.jsonl");
}

describe("mirrorCodexAppServerTranscript", () => {
  it("runs before_message_write before appending mirrored transcript messages", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event: { message: { role: string; content: string } }) => ({
            message: { ...event.message, content: `${event.message.content} [hooked]` },
          }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [{ role: "assistant", content: "hello", timestamp: Date.now() }],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"content":"hello [hooked]"');
  });

  it("respects before_message_write blocking decisions", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({ block: true }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "session-1",
      messages: [{ role: "assistant", content: "should not persist", timestamp: Date.now() }],
      idempotencyScope: "scope-1",
    });

    await expect(fs.readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
