import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function waitForFileContains(filePath: string, text: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content.includes(text)) {
        return;
      }
    } catch {
      // Raw-stream writes are async and may not have created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath} to contain ${text}`);
}

describe("appendRawStream", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_RAW_STREAM;
    delete process.env.OPENCLAW_RAW_STREAM_PATH;
    vi.resetModules();
  });

  it("stays disabled by default", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-raw-stream-off-"));
    const logFile = path.join(tmpDir, "raw-stream.jsonl");
    process.env.OPENCLAW_RAW_STREAM_PATH = logFile;

    const { appendRawStream } = await import("./pi-embedded-subscribe.raw-stream.js");
    appendRawStream({ text: "hello" });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(fs.readFile(logFile, "utf8")).rejects.toThrow();
  });

  it("redacts structured secrets before writing raw stream logs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-raw-stream-"));
    const logFile = path.join(tmpDir, "raw-stream.jsonl");
    process.env.OPENCLAW_RAW_STREAM = "1";
    process.env.OPENCLAW_RAW_STREAM_PATH = logFile;

    const { appendRawStream } = await import("./pi-embedded-subscribe.raw-stream.js");

    appendRawStream({
      event: "assistant_delta",
      text: "Authorization: Bearer abcdef1234567890ghij",
      note: "preserve this text",
    });

    await waitForFileContains(logFile, "Authorization: Bearer abcdef…ghij");

    const raw = await fs.readFile(logFile, "utf8");
    expect(raw).toContain("preserve this text");
    expect(raw).not.toContain("Authorization: Bearer abcdef1234567890ghij");
  });
});
