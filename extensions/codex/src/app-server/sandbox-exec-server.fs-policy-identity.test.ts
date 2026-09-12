// Codex tests cover canonical filesystem policy identity across sandbox bridges.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  codexFsSandboxContext,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  globPath,
  openSocket,
  rpc,
  specialPath,
} from "./sandbox-exec-server.test-helpers.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandboxExecServerRegistry.closeAll();
});

describe("OpenClaw Codex sandbox exec-server filesystem policy identity", () => {
  it("denies read operations whose physical file identity is policy-protected", async () => {
    const copyFile = vi.fn(async () => undefined);
    const readFile = vi.fn(async () => Buffer.from("secret"));
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    // SAFETY: The focused bridge fixture always returns file metadata.
    const stat = vi.fn(async () => ({ type: "file" as const, size: 6, mtimeMs: 1 }));
    const canonicalize = (filePath: string) =>
      filePath
        .replace("/workspace/PRIVATE", "/workspace/private")
        .replace("/workspace/private/SECRET.txt", "/workspace/private/secret.txt");
    const sandbox = createSandboxContext({
      copyFile,
      readFile,
      resolvePolicyPath: async ({ filePath }) => canonicalize(filePath),
      resolvePath: ({ filePath }) => ({ relativePath: filePath, containerPath: filePath }),
      runShellCommand,
      stat,
    });
    const client = createClient();
    // SAFETY: createClient implements the app-server methods exercised by this test.
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
    const filePolicy = codexFsSandboxContext({
      entries: [
        { path: specialPath("project_roots"), access: "write" },
        { path: globPath("private/*.txt"), access: "deny" },
      ],
    });
    const directoryPolicy = codexFsSandboxContext({
      entries: [
        { path: specialPath("project_roots"), access: "read" },
        { path: { type: "path", path: "file:///workspace/private" }, access: "deny" },
      ],
    });

    for (const [method, params] of [
      ["fs/readFile", { path: "file:///workspace/PRIVATE/secret.txt", sandbox: filePolicy }],
      [
        "fs/open",
        {
          handleId: "case-read",
          path: "file:///workspace/PRIVATE/secret.txt",
          sandbox: filePolicy,
        },
      ],
      ["fs/getMetadata", { path: "file:///workspace/private/SECRET.txt", sandbox: filePolicy }],
      ["fs/readDirectory", { path: "file:///workspace/PRIVATE", sandbox: directoryPolicy }],
      [
        "fs/copy",
        {
          sourcePath: "file:///workspace/PRIVATE/secret.txt",
          destinationPath: "file:///workspace/copied.txt",
          sandbox: filePolicy,
        },
      ],
      // SAFETY: Preserve each RPC method and parameter tuple for the test driver.
    ] as const) {
      await expect(rpc(socket, method, params)).rejects.toThrow(
        "Codex fs sandbox denied read access",
      );
    }

    expect(copyFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    socket.close();
  });

  it("uses the authorized physical identity for final read I/O", async () => {
    const stat = vi.fn(async () => ({ type: "file" as const, size: 7, mtimeMs: 1 }));
    const readFile = vi.fn(async () => Buffer.from("allowed"));
    const sandbox = createSandboxContext({
      readFile,
      resolvePolicyPath: async ({ filePath }) =>
        filePath.replace("/workspace/alias", "/workspace/physical"),
      stat,
    });
    const client = createClient();
    // SAFETY: createClient implements the app-server methods exercised by this test.
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    const policy = codexFsSandboxContext({
      entries: [{ path: specialPath("project_roots"), access: "read" }],
    });

    await expect(
      rpc(socket, "fs/readFile", {
        path: "file:///workspace/alias/note.txt",
        sandbox: policy,
      }),
    ).resolves.toEqual({ dataBase64: Buffer.from("allowed").toString("base64") });
    expect(stat).toHaveBeenCalledWith({ filePath: "/workspace/physical/note.txt" });
    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/physical/note.txt",
      maxBytes: 512 * 1024 * 1024,
    });
    socket.close();
  });
});
