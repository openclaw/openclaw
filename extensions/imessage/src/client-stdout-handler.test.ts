import { describe, expect, it, vi } from "vitest";
import {
  classifyImsgStdoutLine,
  ImsgStdoutHandler,
  IMessagePermissionDeniedError,
} from "./client-stdout-handler.js";

const FDA_HELP_TEXT = [
  "⚠️  Permission Error: Cannot access Messages database",
  "authorization denied (code: 23)",
  "",
  "The Messages database at /Users/example/Library/Messages/chat.db requires Full Disk Access permission.",
  "",
  "To fix:",
  "1. Open System Settings → Privacy & Security → Full Disk Access",
  "2. Add your terminal application and any parent launcher (VS Code, Node, gateway, etc.)",
  "3. Also add the built-in Terminal.app if you normally use another terminal",
  "4. Toggle stale entries off and on after terminal/Homebrew/app updates",
  "5. Restart the terminal or parent app, then try again",
  "Note: This is required because macOS protects the Messages database.",
  "For more details, see: https://github.com/steipete/imsg#permissions-troubleshooting",
];

describe("classifyImsgStdoutLine", () => {
  it("treats blank lines as empty", () => {
    expect(classifyImsgStdoutLine("")).toEqual({ kind: "empty" });
    expect(classifyImsgStdoutLine("   ")).toEqual({ kind: "empty" });
  });

  it("parses well-formed JSON-RPC frames", () => {
    const result = classifyImsgStdoutLine('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}');
    expect(result.kind).toBe("json-frame");
    if (result.kind === "json-frame") {
      expect(result.parsed.id).toBe(7);
    }
  });

  it("flags Full Disk Access banner lines", () => {
    expect(
      classifyImsgStdoutLine("⚠️  Permission Error: Cannot access Messages database").kind,
    ).toBe("permission-denied");
    expect(classifyImsgStdoutLine("authorization denied (code: 23)").kind).toBe(
      "permission-denied",
    );
    expect(
      classifyImsgStdoutLine("The Messages database requires Full Disk Access permission.").kind,
    ).toBe("permission-denied");
  });

  it("treats other non-JSON output as noise", () => {
    expect(classifyImsgStdoutLine("To fix:").kind).toBe("noise");
    expect(classifyImsgStdoutLine("1. Open System Settings").kind).toBe("noise");
  });

  it("treats malformed JSON as noise rather than crashing", () => {
    expect(classifyImsgStdoutLine("{not really json").kind).toBe("noise");
  });
});

describe("ImsgStdoutHandler", () => {
  function makeHandler() {
    const onJsonFrame = vi.fn();
    const onPermissionDenied = vi.fn();
    const onNoiseFlushed = vi.fn();
    const handler = new ImsgStdoutHandler({ onJsonFrame, onPermissionDenied, onNoiseFlushed });
    return { handler, onJsonFrame, onPermissionDenied, onNoiseFlushed };
  }

  it("groups the entire FDA help banner into a single flush instead of per-line spam", () => {
    const { handler, onJsonFrame, onPermissionDenied, onNoiseFlushed } = makeHandler();

    for (const line of FDA_HELP_TEXT) {
      handler.handle(line);
    }
    handler.flush();

    expect(onJsonFrame).not.toHaveBeenCalled();
    expect(onPermissionDenied).toHaveBeenCalledTimes(1);
    expect(onPermissionDenied.mock.calls[0]?.[0]).toBeInstanceOf(IMessagePermissionDeniedError);
    expect(onNoiseFlushed).toHaveBeenCalledTimes(1);
    const flushed = onNoiseFlushed.mock.calls[0]?.[0] as string;
    expect(flushed).toContain("Full Disk Access permission");
    expect(flushed).toContain("Restart the terminal");
  });

  it("only raises permission-denied once across many banner lines from the same spawn", () => {
    const { handler, onPermissionDenied } = makeHandler();
    handler.handle("⚠️  Permission Error: Cannot access Messages database");
    handler.handle("authorization denied (code: 23)");
    handler.handle("Full Disk Access permission required");
    expect(onPermissionDenied).toHaveBeenCalledTimes(1);
  });

  it("forwards JSON-RPC frames untouched and flushes any buffered banner first", () => {
    const { handler, onJsonFrame, onNoiseFlushed } = makeHandler();
    handler.handle("warmup banner line"); // buffered noise
    handler.handle('{"jsonrpc":"2.0","id":1,"result":{"chats":[]}}');

    expect(onNoiseFlushed).toHaveBeenCalledTimes(1);
    expect(onNoiseFlushed.mock.calls[0]?.[0]).toContain("warmup banner");
    expect(onJsonFrame).toHaveBeenCalledTimes(1);
    expect(onJsonFrame.mock.calls[0]?.[0]).toMatchObject({ id: 1 });
  });

  it("caps the buffer so a runaway imsg cannot grow memory unbounded", () => {
    const onNoiseFlushed = vi.fn();
    const handler = new ImsgStdoutHandler(
      {
        onJsonFrame: vi.fn(),
        onPermissionDenied: vi.fn(),
        onNoiseFlushed,
      },
      { maxBufferedLines: 3 },
    );
    for (let i = 0; i < 20; i++) {
      handler.handle(`noise line ${i}`);
    }
    handler.flush();
    const flushed = onNoiseFlushed.mock.calls[0]?.[0] as string;
    expect(flushed.split("\n")).toHaveLength(3);
  });

  it("flush is a no-op when nothing is buffered", () => {
    const { handler, onNoiseFlushed } = makeHandler();
    handler.flush();
    handler.flush();
    expect(onNoiseFlushed).not.toHaveBeenCalled();
  });

  it("exposes the permission error so callers can fail-fast on later requests", () => {
    const { handler } = makeHandler();
    expect(handler.getPermissionError()).toBeNull();
    handler.handle("⚠️  Permission Error: Cannot access Messages database");
    expect(handler.getPermissionError()).toBeInstanceOf(IMessagePermissionDeniedError);
  });
});
