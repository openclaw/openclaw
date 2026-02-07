import fsSync from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripOversizedImageFromSession } from "./strip-oversized-image.js";

describe("stripOversizedImageFromSession", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), "strip-image-test-"));
  });

  afterEach(async () => {
    await fsAsync.rm(tmpDir, { recursive: true, force: true });
  });

  function writeSessionSync(entries: unknown[]): string {
    const file = path.join(tmpDir, "session.jsonl");
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fsSync.writeFileSync(file, content);
    return file;
  }

  it("strips an image block from a user message by index", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "Look at this image" },
            { type: "image", data: "base64oversized", mimeType: "image/jpeg" },
          ],
        },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I see the image" }],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const userMsg = lines[1];
    expect(userMsg.message.content).toHaveLength(2);
    expect(userMsg.message.content[0].type).toBe("text");
    expect(userMsg.message.content[0].text).toBe("Look at this image");
    expect(userMsg.message.content[1].type).toBe("text");
    expect(userMsg.message.content[1].text).toContain("omitted");
    expect(userMsg.message.content[1].text).toContain("exceeds size limit");
  });

  it("handles message index referring to the Nth message in the context", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
        },
      },
      {
        type: "message",
        id: "c",
        parentId: "b",
        message: {
          role: "user",
          content: [
            { type: "text", text: "See this" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    // In the context messages array: msg[0]=user, msg[1]=assistant, msg[2]=user
    const stripped = await stripOversizedImageFromSession(file, 2, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Fourth entry (index 3 in file, the second user message) should have image stripped
    const secondUser = lines[3];
    expect(secondUser.message.content[1].type).toBe("text");
    expect(secondUser.message.content[1].text).toContain("omitted");
  });

  it("returns false when session file does not exist", async () => {
    const stripped = await stripOversizedImageFromSession("/nonexistent/file.jsonl", 0, 1);
    expect(stripped).toBe(false);
  });

  it("returns false when message index is out of range", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: "hello" },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 99, 0);
    expect(stripped).toBe(false);
  });

  it("returns false when content index is out of range", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "no image" }],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, 5);
    expect(stripped).toBe(false);
  });

  it("returns false when target content block is not an image", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, 1);
    expect(stripped).toBe(false);
  });

  it("strips all images from a message when contentIndex is undefined", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "Two images" },
            { type: "image", data: "img1", mimeType: "image/jpeg" },
            { type: "image", data: "img2", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, undefined);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const userMsg = lines[1];

    expect(userMsg.message.content).toHaveLength(3);
    expect(userMsg.message.content[0].type).toBe("text");
    expect(userMsg.message.content[0].text).toBe("Two images");
    expect(userMsg.message.content[1].type).toBe("text");
    expect(userMsg.message.content[1].text).toContain("omitted");
    expect(userMsg.message.content[2].type).toBe("text");
    expect(userMsg.message.content[2].text).toContain("omitted");
  });
});
