import { describe, expect, it, vi } from "vitest";
import { sendMessageSpy } from "./bot.media.e2e-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandler,
  createBotHandlerWithOptions,
  mockTelegramPngDownload,
} from "./bot.media.test-utils.js";

// Use real timers with short test timing values (25ms batch window).
// The async promise chain inside processDocumentBatch (resolveMedia → processMessage)
// doesn't resolve cleanly under fake timers, so we let real timers flush naturally.
const DOC_BATCH_SETTLE_MS = TELEGRAM_TEST_TIMINGS.documentBatchFlushMs + 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("telegram document batch", () => {
  const DOC_BATCH_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;

  it(
    "batches multiple document messages from the same sender into a single processMessage call",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();

      const from = { id: 999, is_bot: false, first_name: "User" };

      // Send 3 documents in quick succession (no await gap between dispatches)
      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 1,
          from,
          caption: "Read all these files",
          date: 1736380800,
          document: { file_id: "doc1", file_unique_id: "u1", file_name: "session01.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/session01.md" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 2,
          from,
          date: 1736380801,
          document: { file_id: "doc2", file_unique_id: "u2", file_name: "session02.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/session02.md" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 3,
          from,
          date: 1736380802,
          document: { file_id: "doc3", file_unique_id: "u3", file_name: "session03.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/session03.md" }),
      });

      // Wait for the batch window to flush
      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      // Caption from first message with caption should be present
      expect(payload.Body).toContain("Read all these files");
      // All 3 documents resolved as media
      expect(payload.MediaPaths).toHaveLength(3);

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "a single document flushes after the batch window",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 10,
          from: { id: 999, is_bot: false, first_name: "User" },
          caption: "Just one file",
          date: 1736380800,
          document: { file_id: "docA", file_unique_id: "uA", file_name: "report.pdf" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/report.pdf" }),
      });

      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0][0].MediaPaths).toHaveLength(1);

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "does not batch documents from different senders",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 20,
          date: 1736380800,
          from: { id: 111, is_bot: false, first_name: "Alice" },
          document: { file_id: "docX", file_unique_id: "uX", file_name: "alice.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/alice.md" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 21,
          date: 1736380801,
          from: { id: 222, is_bot: false, first_name: "Bob" },
          document: { file_id: "docY", file_unique_id: "uY", file_name: "bob.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/bob.md" }),
      });

      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      // Each sender's documents should flush separately
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[0][0].MediaPaths).toHaveLength(1);
      expect(replySpy.mock.calls[1][0].MediaPaths).toHaveLength(1);

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "sends oversize warning for files that exceed the size limit in a batch",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      sendMessageSpy.mockClear();

      // First doc succeeds, second doc triggers oversize error, third doc succeeds
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : "";
        if (urlStr.includes("big-file.pdf")) {
          throw new Error("File exceeds 20 MB limit");
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/pdf" },
          arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
        } as unknown as Response;
      });

      const from = { id: 999, is_bot: false, first_name: "User" };

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 30,
          from,
          caption: "Three files, one too big",
          date: 1736380800,
          document: { file_id: "small1", file_unique_id: "s1", file_name: "small1.pdf" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/small1.pdf" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 31,
          from,
          date: 1736380801,
          document: { file_id: "big1", file_unique_id: "b1", file_name: "big-file.pdf" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/big-file.pdf" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 32,
          from,
          date: 1736380802,
          document: { file_id: "small2", file_unique_id: "s2", file_name: "small2.pdf" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/small2.pdf" }),
      });

      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      // The batch still processes the 2 good files
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0][0].MediaPaths).toHaveLength(2);

      // The oversize file triggered a warning message to the user
      const oversizeCalls = sendMessageSpy.mock.calls.filter(
        (call: unknown[]) => typeof call[1] === "string" && call[1].includes("File too large"),
      );
      expect(oversizeCalls).toHaveLength(1);
      // Warning replied to the specific oversize message
      expect(oversizeCalls[0][2]).toEqual(expect.objectContaining({ reply_to_message_id: 31 }));

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "preserves caption entities (text_link) through document batch",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();

      const from = { id: 999, is_bot: false, first_name: "User" };

      // First doc has a caption with a text_link entity
      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 40,
          from,
          caption: "Check this link",
          caption_entities: [
            { type: "text_link", offset: 11, length: 4, url: "https://example.com" },
          ],
          date: 1736380800,
          document: { file_id: "doc1", file_unique_id: "u1", file_name: "file1.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/file1.md" }),
      });

      // Second doc has no caption
      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 41,
          from,
          date: 1736380801,
          document: { file_id: "doc2", file_unique_id: "u2", file_name: "file2.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/file2.md" }),
      });

      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      // The text_link entity should be expanded into a markdown link
      expect(payload.Body).toContain("[link](https://example.com)");

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "skips agent turn when all documents in a batch fail to resolve",
    async () => {
      const runtimeLog = vi.fn();
      const { handler, replySpy, runtimeError } = await createBotHandlerWithOptions({
        runtimeLog,
      });
      sendMessageSpy.mockClear();

      // All fetches fail with oversize error
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("File exceeds 20 MB limit");
      });

      const from = { id: 999, is_bot: false, first_name: "User" };

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 50,
          from,
          caption: "These are huge",
          date: 1736380800,
          document: { file_id: "big1", file_unique_id: "b1", file_name: "huge1.pdf" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/huge1.pdf" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 51,
          from,
          date: 1736380801,
          document: { file_id: "big2", file_unique_id: "b2", file_name: "huge2.pdf" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/huge2.pdf" }),
      });

      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      // Agent turn should NOT have been opened
      expect(replySpy).not.toHaveBeenCalled();
      // Oversize warnings should still have been sent
      const oversizeCalls = sendMessageSpy.mock.calls.filter(
        (call: unknown[]) => typeof call[1] === "string" && call[1].includes("File too large"),
      );
      expect(oversizeCalls).toHaveLength(2);

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );
});
