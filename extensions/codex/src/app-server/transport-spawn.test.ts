import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";
import { observeManagedCodexLauncherFailure } from "./managed-launcher-failure.js";
import { findCodexAppServerSpawnError } from "./spawn-error.js";
import * as stdioWorker from "./stdio-worker.js";
import { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";
import { createStdioTransport } from "./transport-stdio.js";
import type { CodexAppServerTransport } from "./transport.js";

const registration = vi.hoisted(() => ({ rejectOnExit: false, holdStderrUntilExit: false }));

vi.mock("./stdio-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stdio-worker.js")>()),
}));

// mock-isolation: delay registration around real native launch failures and stderr drain.
vi.mock("./transport-process-registration.js", () => ({
  prepareCodexAppServerProcessRegistration:
    async () => async (child: stdioWorker.CodexStdioChild) => {
      if (registration.holdStderrUntilExit) {
        child.stderr?.pause();
        child.once("exit", () => child.stderr?.resume());
      }
      await once(child, "spawn");
      if (registration.rejectOnExit) {
        await once(child, "exit");
        throw new Error("fixture registration observed an early process exit");
      }
    },
  waitForCodexAppServerProcessRegistrationCleanup: async () => {},
}));

describe("Codex app-server OS launch failure", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.runIf(process.platform !== "win32").each(["initialize", "registration"])(
    "retains native EACCES ahead of large spawn arguments during %s with stderr after exit",
    async (phase) => {
      const root = tempDirs.make("codex-launcher-failure-");
      const installedLauncher = createRequire(import.meta.url).resolve(
        "@openai/codex/bin/codex.js",
      );
      const installedNative = resolveManagedCodexNativeCommand(installedLauncher);
      if (!installedNative) {
        throw new Error("The pinned native Codex package is required for launcher proof");
      }
      const triple = path.basename(path.dirname(path.dirname(installedNative)));
      const packageRoot = path.join(root, "node_modules", "@openai", "codex");
      const launcher = path.join(packageRoot, "bin", "codex.js");
      const native = path.join(packageRoot, "vendor", triple, "bin", "codex");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.mkdir(path.dirname(native), { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openai/codex", type: "module" }),
      );
      await fs.copyFile(installedLauncher, launcher);
      await fs.writeFile(native, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      const options = {
        transport: "stdio" as const,
        commandSource: "resolved-managed" as const,
        command: launcher,
        args: ["app-server", "--listen", "stdio://", "-c", `fixture="${"x".repeat(20_000)}"`],
        headers: {},
        env: { HOME: root, CODEX_HOME: path.join(root, "codex-home") },
      };
      let client: CodexAppServerClient | undefined;
      const spawn = vi.spyOn(stdioWorker, "spawnCodexStdio");
      try {
        registration.rejectOnExit = phase === "registration";
        registration.holdStderrUntilExit = true;
        const failure = await (async () => {
          if (phase === "registration") {
            await createStdioTransport(options);
            return;
          }
          client = await CodexAppServerClient.start(options);
          await client.initialize();
        })().catch((error: unknown) => error);
        const launchFailure = findCodexAppServerSpawnError(failure);
        expect(launchFailure).toMatchObject({
          name: "CodexAppServerSpawnError",
          command: native,
          message: expect.stringContaining(`${native} is not executable`),
        });
        expect(spawn).toHaveBeenCalledOnce();
        await expect(CodexAppServerClient.start(options)).rejects.toMatchObject({
          command: native,
        });
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        registration.rejectOnExit = false;
        registration.holdStderrUntilExit = false;
        await client?.closeAndWait();
        spawn.mockRestore();
      }
    },
  );
});

describe("managed launcher diagnostic attribution", () => {
  it.each(["'", '"'])(
    "attributes execve diagnostics with %s quoting to the native path",
    (quote) => {
      for (const matches of [true, false]) {
        const native = `/synthetic/codex-${randomUUID()}`;
        const child: RegistrationTestChildProcess &
          Pick<CodexAppServerTransport, "startupFailure"> = new RegistrationTestChildProcess(1);
        observeManagedCodexLauncherFailure(child, native);
        const diagnostic = `Error: EACCES, Permission denied
  code: ${quote}EACCES${quote},
  path: ${quote}${matches ? native : "/other/codex"}${quote},
  syscall: ${quote}execve${quote}
`;
        for (const chunk of [diagnostic.slice(0, 25), diagnostic.slice(25)]) {
          child.stderr.emit("data", Buffer.from(chunk));
        }
        child.exitCode = 1;
        child.emit("exit", 1);
        child.emit("close", 1);
        if (matches) {
          expect(child.startupFailure?.error).toMatchObject({
            name: "CodexAppServerSpawnError",
            command: native,
            cause: expect.objectContaining({ code: "EACCES" }),
          });
        } else {
          expect(child.startupFailure?.error).toBeUndefined();
        }
      }
    },
  );

  it.each([
    { name: "matching Bun diagnostic", accepted: true },
    { name: "different header command", header: "/other/codex", accepted: false },
    { name: "different syscall command", syscall: "spawn /other/codex", accepted: false },
    { name: "successful exit", exit: 0, accepted: false },
    { name: "diagnostic beyond prefix limit", padding: `${"x".repeat(16_383)}\n`, accepted: false },
    { name: "Node execve abort", execveAbort: true, signal: "SIGABRT" as const, accepted: true },
    {
      name: "Node execve abort with late stderr",
      execveAbort: true,
      signal: "SIGABRT" as const,
      lateStderr: true,
      accepted: true,
    },
    { name: "unrelated abort", signal: "SIGABRT" as const, accepted: false },
    { name: "Node execve header without abort", execveAbort: true, accepted: false },
    {
      name: "Node execve header with another signal",
      execveAbort: true,
      signal: "SIGTERM" as const,
      accepted: false,
    },
  ])(
    "classifies $name",
    ({ header, syscall, exit, padding, execveAbort, signal, lateStderr, accepted }) => {
      const native = `/synthetic/codex-${randomUUID()}`;
      const child: RegistrationTestChildProcess & Pick<CodexAppServerTransport, "startupFailure"> =
        new RegistrationTestChildProcess(1);
      observeManagedCodexLauncherFailure(child, native);
      const diagnostic = execveAbort
        ? "process.execve failed with error code EACCES\n"
        : `${padding ?? ""}EACCES: permission denied, posix_spawn '${header ?? native}'
   syscall: "${syscall ?? `spawn ${native}`}",
`;
      if (lateStderr) {
        child.exitCode = null;
        child.signalCode = signal ?? null;
        child.emit("exit", child.exitCode, child.signalCode);
      }
      for (const chunk of [diagnostic.slice(0, 12), diagnostic.slice(12)]) {
        child.stderr.emit("data", Buffer.from(chunk));
      }
      if (!lateStderr) {
        child.exitCode = signal ? null : (exit ?? 1);
        child.signalCode = signal ?? null;
        child.emit("exit", child.exitCode, child.signalCode);
      }
      child.emit("close", child.exitCode);
      if (accepted) {
        expect(child.startupFailure?.error).toMatchObject({
          name: "CodexAppServerSpawnError",
          command: native,
          cause: expect.objectContaining({ code: "EACCES" }),
        });
      } else {
        expect(child.startupFailure?.error).toBeUndefined();
      }
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
    },
  );
});
