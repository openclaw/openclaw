import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
  const _THINKING_TAG_CASES = [
    { tag: "think", open: "<think>", close: "</think>" },
    { tag: "thinking", open: "<thinking>", close: "</thinking>" },
    { tag: "thought", open: "<thought>", close: "</thought>" },
    { tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
  ] as const;

  it("waits for multiple compaction retries before resolving", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-3",
    });

    for (const listener of listeners) {
      listener({ type: "auto_compaction_end", willRetry: true });
      listener({ type: "auto_compaction_end", willRetry: true });
    }

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await waitPromise;
    expect(resolved).toBe(true);
  });
  it("emits tool summaries at tool start when verbose is on", async () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onToolResult = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-tool",
      verboseLevel: "on",
      onToolResult,
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { path: "/tmp/a.txt" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = onToolResult.mock.calls[0][0];
    expect(payload.text).toContain("/tmp/a.txt");

    handler?.({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "tool-1",
      isError: false,
      result: "ok",
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
  it("includes browser action metadata in tool summaries", async () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onToolResult = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-browser-tool",
      verboseLevel: "on",
      onToolResult,
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "browser",
      toolCallId: "tool-browser-1",
      args: { action: "snapshot", targetUrl: "https://example.com" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = onToolResult.mock.calls[0][0];
    expect(payload.text).toContain("🌐");
    expect(payload.text).toContain("browser");
    expect(payload.text).toContain("snapshot");
    expect(payload.text).toContain("https://example.com");
  });

  it("emits exec output in full verbose mode and includes PTY indicator", async () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onToolResult = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-exec-full",
      verboseLevel: "full",
      onToolResult,
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-exec-1",
      args: { command: "claude", pty: true },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const summary = onToolResult.mock.calls[0][0];
    expect(summary.text).toContain("exec");
    expect(summary.text).toContain("pty");

    handler?.({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-exec-1",
      isError: false,
      result: { content: [{ type: "text", text: "hello\nworld" }] },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(2);
    const output = onToolResult.mock.calls[1][0];
    expect(output.text).toContain("hello");
    expect(output.text).toContain("```txt");

    handler?.({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "tool-read-1",
      isError: false,
      result: { content: [{ type: "text", text: "file data" }] },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(3);
    const readOutput = onToolResult.mock.calls[2][0];
    expect(readOutput.text).toContain("file data");
  });
});
