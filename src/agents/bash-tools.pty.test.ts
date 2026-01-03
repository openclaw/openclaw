import { describe, expect, it, vi } from "vitest";

describe("bash tool pty mode", () => {
  it("falls back to pipe with warning when node-pty fails to load", async () => {
    vi.resetModules();
    vi.doMock("node-pty", () => {
      throw new Error("boom");
    });

    const { createBashTool } = await import("./bash-tools.js");
    const tool = createBashTool({ backgroundMs: 10, timeoutSec: 1 });
    const result = await tool.execute("call", {
      command: "echo test",
      stdinMode: "pty",
    });

    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("Warning: node-pty failed to load");
    expect(text).toContain("falling back to pipe mode.");

    vi.doUnmock("node-pty");
  });

  it("uses node-pty when available", async () => {
    vi.resetModules();
    const spawn = vi.fn(() => {
      let onData: ((data: string) => void) | undefined;
      let onExit:
        | ((event: { exitCode: number | null; signal?: number | null }) => void)
        | undefined;
      const pty = {
        pid: 4321,
        onData: (cb: (data: string) => void) => {
          onData = cb;
        },
        onExit: (
          cb: (event: {
            exitCode: number | null;
            signal?: number | null;
          }) => void,
        ) => {
          onExit = cb;
        },
        write: vi.fn(),
        kill: vi.fn(),
      };
      setTimeout(() => {
        onData?.("hello\n");
        onExit?.({ exitCode: 0, signal: null });
      }, 10);
      return pty;
    });
    vi.doMock("node-pty", () => ({ spawn }));

    const { createBashTool } = await import("./bash-tools.js");
    const tool = createBashTool({ backgroundMs: 10, timeoutSec: 1 });
    const result = await tool.execute("call", {
      command: "ignored",
      stdinMode: "pty",
    });

    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("hello");
    expect(text).not.toContain("Warning:");

    vi.doUnmock("node-pty");
  });
});
