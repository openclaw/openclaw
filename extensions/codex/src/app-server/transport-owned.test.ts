import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import * as processes from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createOwnedCodexStdioTransport } from "./transport-owned.js";
import {
  closeCodexAppServerTransport,
  closeCodexAppServerTransportAndWait,
  type CodexAppServerTransport,
} from "./transport.js";

function mockProcessOwner(status: "confirmed" | "uncertain", naturalExit = false) {
  const stdin = new PassThrough();
  let exited: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const owner: processes.OwnedStdioProcess = {
    stdin,
    supportsRawOutput: true,
    onStdout: () => {},
    onStderr: () => {},
    onError: () => {},
    onExit: (listener) => {
      exited = listener;
      if (naturalExit) {
        listener(0, null);
      }
    },
    wait: async () => ({ code: 0, signal: null }),
    waitForExtinction: async () =>
      status === "confirmed" ? { status } : { status, reason: "job-unavailable" },
    kill: () => {},
    dispose: () => {
      stdin.destroy();
    },
  };
  vi.spyOn(processes, "createOwnedStdioProcess").mockResolvedValue(owner);
  const close = vi.spyOn(processes, "closeOwnedStdioProcess").mockImplementation(async () => {
    exited?.(0, null);
    owner.dispose();
  });
  return { owner, close };
}

describe("retained runtime-probe process ownership", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());

  it("settles a real signal-forwarding launcher and its native child after protocol use", async () => {
    const root = dirs.make("codex-owned-probe-");
    const native = path.join(root, "native.cjs");
    const launcher = path.join(root, "launcher.cjs");
    await fs.writeFile(
      native,
      `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: message.method === "initialize" ? { userAgent: "codex-cli/0.160.0" } : { pid: process.pid } }) + "\\n");
});
lines.on("close", () => process.exit(0));
`,
    );
    await fs.writeFile(
      launcher,
      `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [${JSON.stringify(native)}], { stdio: "inherit" });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
`,
    );
    const client = await CodexAppServerClient.start(
      {
        transport: "stdio",
        commandSource: "resolved-managed",
        command: launcher,
        args: ["app-server"],
        cwd: root,
        env: { HOME: root, CODEX_HOME: root },
      },
      () => {},
      { ownership: "retained-tree", signal: new AbortController().signal },
    );
    let nativePid: number | undefined;
    try {
      await client.initialize();
      expect(client.getServerVersion()).toBe("0.160.0");
      nativePid = (await client.request<{ pid: number }>("fixture/pid", {})).pid;
      expect(nativePid).toBeGreaterThan(1);
      expect(() => process.kill(nativePid!, 0)).not.toThrow();
    } finally {
      expect(await client.closeAndWait()).toEqual({ exited: true, cleanup: "closed" });
    }
    expect(() => process.kill(nativePid!, 0)).toThrow();
  });

  it.each(["confirmed", "uncertain"] as const)(
    "uses the canonical %s tree outcome, not just root exit",
    async (status) => {
      const { close } = mockProcessOwner(status);
      let transport!: CodexAppServerTransport;
      await createOwnedCodexStdioTransport(
        resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { command: "/fixture/codex" } },
        }).start,
        new AbortController().signal,
        () => {},
        (child) => {
          transport = child;
        },
      );
      // Fire-and-forget close and explicit join share exactly one owner shutdown.
      closeCodexAppServerTransport(transport);
      expect(await closeCodexAppServerTransportAndWait(transport)).toEqual({
        exited: true,
        cleanup: status === "confirmed" ? "closed" : "uncertain",
      });
      expect(close).toHaveBeenCalledOnce();
      expect(transport.stdout).toMatchObject({ destroyed: true });
    },
  );

  it("preserves startup cleanup uncertainty when cancellation also revokes authority", async () => {
    const controller = new AbortController();
    vi.spyOn(processes, "createOwnedStdioProcess").mockImplementation(async () => {
      controller.abort(new Error("fixture startup cancelled"));
      throw new processes.OwnedStdioCleanupError("fixture tree cleanup uncertain");
    });
    await expect(
      CodexAppServerClient.start(
        { transport: "stdio", commandSource: "config", command: "/fixture/codex" },
        () => controller.signal.throwIfAborted(),
        { ownership: "retained-tree", signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  });

  it("preserves an admitted process's uncertain cleanup after natural exit and registration refusal", async () => {
    const { close, owner } = mockProcessOwner("uncertain", true);
    let checks = 0;
    try {
      await expect(
        CodexAppServerClient.start(
          { transport: "stdio", commandSource: "config", command: "/fixture/codex" },
          () => {
            if (++checks >= 2) {
              throw new Error("fixture registration refused");
            }
          },
          { ownership: "retained-tree", signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
      expect(close).toHaveBeenCalledOnce();
      expect(owner.stdin).toMatchObject({ destroyed: true });
    } finally {
      owner.dispose();
    }
  });

  it("preserves uncertain startup cleanup as the canonical retained-artifact error", async () => {
    vi.spyOn(processes, "createOwnedStdioProcess").mockRejectedValue(
      new processes.OwnedStdioCleanupError("fixture cleanup failed"),
    );
    const onSpawn = vi.fn();
    await expect(
      createOwnedCodexStdioTransport(
        resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { command: "/fixture/codex" } },
        }).start,
        new AbortController().signal,
        () => {},
        onSpawn,
      ),
    ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
    expect(onSpawn).not.toHaveBeenCalled();
  });
});
