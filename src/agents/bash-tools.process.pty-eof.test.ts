import { afterEach, expect, it, vi } from "vitest";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { TerminalPtyHandle } from "../process/terminal-pty.js";
import { addSession } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn<typeof import("../process/terminal-pty.js").spawnTerminalPty>(),
}));

// Only the external PTY backend is fixed; supervisor, adapter, registry and tool are real.
vi.mock("../process/terminal-pty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/terminal-pty.js")>()),
  spawnTerminalPty: spawnMock,
}));

afterEach(() => {
  resetProcessRegistryForTests();
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

it.each([false, true])(
  "process write reports the PTY EOF outcome (backendFails=%s)",
  async (backendFails) => {
    const eof = process.platform === "win32" ? "\x1a" : "\x04";
    const failure = new Error("synthetic PTY EOF write EIO");
    let exitListener: Parameters<TerminalPtyHandle["onExit"]>[0] | undefined;
    const write = vi.fn<TerminalPtyHandle["write"]>((data) => {
      if (backendFails && data === eof) {
        throw failure;
      }
    });
    const backend: TerminalPtyHandle = {
      pid: 0,
      write,
      resize: () => {},
      pause: () => {},
      resume: () => {},
      onData: () => ({ dispose: () => {} }),
      onExit: (listener) => {
        exitListener = listener;
        return { dispose: () => {} };
      },
      kill: () => {},
    };
    spawnMock.mockResolvedValue(backend);
    const supervisor = createProcessSupervisor();
    try {
      const run = await supervisor.spawn({ mode: "pty", argv: ["synthetic-pty"] });
      expect(run.stdin).toBeDefined();
      const session = createProcessSessionFixture({ id: "pty-eof", backgrounded: true });
      session.stdin = run.stdin;
      addSession(session);
      const tool = createProcessTool();
      const result = tool.execute("pty-eof-write", {
        action: "write",
        sessionId: session.id,
        data: "payload",
        eof: true,
      });
      if (backendFails) {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toMatchObject({
          details: { status: "running", sessionId: session.id },
          content: [{ type: "text", text: "Wrote 7 bytes to session pty-eof (stdin closed)." }],
        });
      }
      expect(write.mock.calls.map(([data]) => data)).toEqual(["payload", eof]);
      expect(run.stdin).toMatchObject({
        writable: false,
        writableEnded: true,
        writableFinished: true,
        destroyed: false,
      });
      // Ended state still rejects a second tool write before touching the backend.
      await expect(
        tool.execute("pty-eof-repeat", {
          action: "write",
          sessionId: session.id,
          data: "again",
          eof: true,
        }),
      ).resolves.toMatchObject({
        details: { status: "failed", error: "Session pty-eof stdin is not writable." },
      });
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      // The fixture produces exit; teardown never signals a real OS PID or waits on a timer.
      exitListener?.({ exitCode: 0 });
      await supervisor.shutdown();
    }
  },
);
