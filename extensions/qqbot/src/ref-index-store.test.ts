import { describe, expect, it } from "vitest";
import { formatRefEntryForAgent } from "./ref-index-store.js";
import type { RefIndexEntry } from "./ref-index-store.js";

describe("formatRefEntryForAgent", () => {
  it("returns [empty message] for entry with no content or attachments", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
    };
    expect(formatRefEntryForAgent(entry)).toBe("[empty message]");
  });

  it("returns [empty message] for entry with whitespace-only content", () => {
    const entry: RefIndexEntry = {
      content: "   ",
      senderId: "user1",
      timestamp: Date.now(),
    };
    expect(formatRefEntryForAgent(entry)).toBe("[empty message]");
  });

  it("returns content text for text-only entry", () => {
    const entry: RefIndexEntry = {
      content: "Hello, how are you?",
      senderId: "user1",
      timestamp: Date.now(),
    };
    expect(formatRefEntryForAgent(entry)).toBe("Hello, how are you?");
  });

  it("preserves CJK content", () => {
    const entry: RefIndexEntry = {
      content: "你好世界，今天天气不错",
      senderId: "user1",
      timestamp: Date.now(),
    };
    expect(formatRefEntryForAgent(entry)).toBe("你好世界，今天天气不错");
  });

  it("formats image attachment without filename", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "image" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[image]");
  });

  it("formats image attachment with filename", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "image", filename: "photo.png" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[image: photo.png]");
  });

  it("formats image attachment with localPath", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "image", localPath: "/tmp/img.png" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[image (/tmp/img.png)]");
  });

  it("formats image attachment with url", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "image", url: "https://example.com/img.png" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[image (https://example.com/img.png)]");
  });

  it("formats voice attachment with transcript", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [
        { type: "voice", transcript: "Hello world", transcriptSource: "stt" },
      ],
    };
    expect(formatRefEntryForAgent(entry)).toBe(
      '[voice message (content: "Hello world" - local STT)]',
    );
  });

  it("formats voice attachment with asr transcript source", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [
        { type: "voice", transcript: "ASR text", transcriptSource: "asr" },
      ],
    };
    expect(formatRefEntryForAgent(entry)).toBe(
      '[voice message (content: "ASR text" - platform ASR)]',
    );
  });

  it("formats voice attachment without transcript", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "voice" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[voice message]");
  });

  it("formats voice attachment with localPath and transcriptSource", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "voice", transcript: "hi", transcriptSource: "stt", localPath: "/tmp/v.silk" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe(
      '[voice message (content: "hi" - local STT) (/tmp/v.silk)]',
    );
  });

  it("formats voice attachment with localPath but no transcriptSource", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "voice", transcript: "hi", localPath: "/tmp/v.silk" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe(
      '[voice message (content: "hi") (/tmp/v.silk)]',
    );
  });

  it("formats video attachment", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "video", filename: "clip.mp4" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[video: clip.mp4]");
  });

  it("formats file attachment", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "file", filename: "report.pdf" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[file: report.pdf]");
  });

  it("formats unknown attachment type", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "unknown", filename: "data.bin" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[attachment: data.bin]");
  });

  it("combines text content with attachments", () => {
    const entry: RefIndexEntry = {
      content: "Check this out",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "image", filename: "pic.png" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe("Check this out [image: pic.png]");
  });

  it("combines multiple attachments", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [
        { type: "image", filename: "a.png" },
        { type: "file", filename: "b.pdf" },
      ],
    };
    expect(formatRefEntryForAgent(entry)).toBe("[image: a.png] [file: b.pdf]");
  });

  it("formats voice with tts transcript source", () => {
    const entry: RefIndexEntry = {
      content: "",
      senderId: "user1",
      timestamp: Date.now(),
      attachments: [{ type: "voice", transcript: "tts output", transcriptSource: "tts" }],
    };
    expect(formatRefEntryForAgent(entry)).toBe(
      '[voice message (content: "tts output" - TTS source)]',
    );
  });
});
