import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexCommandExecParams, CodexCommandExecResponse } from "./command-exec-protocol.js";
import {
  prepareCodexRemoteWorkspaceMessageMedia,
  readBoundedCodexRemoteWorkspaceFile,
  type CodexRemoteWorkspaceFileReader,
} from "./remote-workspace-media.js";

const remoteWorkspaceRoot = "/remote/codex-workspace";
const execFileAsync = promisify(execFile);
let localWorkspaceRoot: string;
let openClawState: OpenClawTestState;

beforeEach(async () => {
  openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "codex-remote-workspace-media-",
  });
  localWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-workspace-media-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(localWorkspaceRoot, { recursive: true, force: true });
  await openClawState.cleanup();
});

function createRemoteFileReader(files: Record<string, string>) {
  return vi.fn<CodexRemoteWorkspaceFileReader>(async ({ path: remotePath, maxBytes, signal }) => {
    signal?.throwIfAborted();
    const content = files[remotePath];
    if (content === undefined) {
      throw new Error(`Codex remote workspace artifact does not exist: ${remotePath}`);
    }
    const buffer = Buffer.from(content);
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Codex remote workspace artifact exceeds the limit of ${maxBytes} bytes.`);
    }
    return { dataBase64: buffer.toString("base64") };
  });
}

function createLocalCommandClient() {
  return {
    request: vi.fn(
      async (
        _method: "command/exec",
        params: CodexCommandExecParams,
      ): Promise<CodexCommandExecResponse> => {
        try {
          const result = await execFileAsync(params.command[0]!, params.command.slice(1), {
            maxBuffer: Math.max(1_024, params.outputBytesCap ?? 1024 * 1024),
            ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
          });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { code?: number; stderr?: string; message?: string };
          return {
            exitCode: typeof failure.code === "number" ? failure.code : 1,
            stdout: "",
            stderr: failure.stderr ?? failure.message ?? "remote reader failed",
          };
        }
      },
    ),
  };
}

describe("readBoundedCodexRemoteWorkspaceFile", () => {
  it("transfers the exact remote bytes with a no-shell, default-capped command", async () => {
    const filePath = path.join(localWorkspaceRoot, "report $(never-execute).txt");
    await writeFile(filePath, "authoritative remote report\n");
    const client = createLocalCommandClient();

    const result = await readBoundedCodexRemoteWorkspaceFile({
      client,
      path: filePath,
      maxBytes: 64,
      timeoutMs: 9_000,
    });

    expect(Buffer.from(result.dataBase64, "base64").toString()).toBe(
      "authoritative remote report\n",
    );
    expect(client.request).toHaveBeenCalledWith(
      "command/exec",
      expect.objectContaining({
        command: ["node", "-e", expect.any(String), "--", filePath, "64", "0", "524288"],
        env: { NODE_OPTIONS: null, NODE_PATH: null },
        timeoutMs: expect.any(Number),
      }),
      { signal: undefined, timeoutMs: expect.any(Number) },
    );
    expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("outputBytesCap");
  });

  it("reassembles multi-frame files beneath the Windows-safe native output cap", async () => {
    const filePath = path.join(localWorkspaceRoot, "chunked-report.bin");
    const expected = Buffer.alloc(512 * 1024 + 17, 0x61);
    await writeFile(filePath, expected);
    const client = createLocalCommandClient();

    const result = await readBoundedCodexRemoteWorkspaceFile({
      client,
      path: filePath,
      maxBytes: expected.byteLength,
    });

    expect(Buffer.from(result.dataBase64, "base64").equals(expected)).toBe(true);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request.mock.calls[0]?.[1].command).toEqual([
      "node",
      "-e",
      expect.any(String),
      "--",
      filePath,
      String(expected.byteLength),
      "0",
      "524288",
    ]);
    expect(client.request.mock.calls[1]?.[1].command).toEqual([
      "node",
      "-e",
      expect.any(String),
      "--",
      filePath,
      String(expected.byteLength),
      "524288",
      "524288",
    ]);
    expect(client.request.mock.calls[1]?.[1]).not.toHaveProperty("outputBytesCap");
  });

  it.each([
    { timeoutMs: 500, elapsedMs: 100.25, budgets: [500, 399], expires: false },
    { timeoutMs: 500, elapsedMs: 500.25, budgets: [500], expires: true },
    { timeoutMs: undefined, elapsedMs: 500.25, budgets: [undefined, undefined], expires: false },
  ])("keeps chunk deadlines across a clock rewind ($timeoutMs, $elapsedMs)", async (test) => {
    let elapsed = 0;
    let wallClock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    const bytes = Buffer.alloc(512 * 1024 + 17, 0x62);
    let offset = 0;
    const request = vi.fn(
      async (
        _method: "command/exec",
        _params: CodexCommandExecParams,
        _options: { timeoutMs?: number },
      ): Promise<CodexCommandExecResponse> => {
        const chunk = bytes.subarray(offset, offset + 512 * 1024);
        offset += chunk.byteLength;
        elapsed = test.elapsedMs;
        wallClock -= 5_000;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            dataBase64: chunk.toString("base64"),
            size: bytes.byteLength,
            revision: "stable-file",
          }),
          stderr: "",
        };
      },
    );
    const transfer = readBoundedCodexRemoteWorkspaceFile({
      client: { request },
      path: "/remote/chunked.bin",
      maxBytes: bytes.byteLength,
      timeoutMs: test.timeoutMs,
    });
    if (test.expires) {
      await expect(transfer).rejects.toThrow("timed out");
    } else {
      expect(Buffer.from((await transfer).dataBase64, "base64")).toEqual(bytes);
    }
    expect(request.mock.calls.map(([, params]) => params.timeoutMs)).toEqual(test.budgets);
    expect(request.mock.calls.map((call) => call[2].timeoutMs)).toEqual(test.budgets);
  });

  it("rejects oversized remote files before base64 allocation or transfer", async () => {
    const filePath = path.join(localWorkspaceRoot, "oversized.txt");
    await writeFile(filePath, "too many bytes");

    await expect(
      readBoundedCodexRemoteWorkspaceFile({
        client: createLocalCommandClient(),
        path: filePath,
        maxBytes: 3,
      }),
    ).rejects.toThrow("limit of 3 bytes");
  });

  it("rejects remote symbolic links before opening their target", async () => {
    const target = path.join(localWorkspaceRoot, "private.txt");
    const link = path.join(localWorkspaceRoot, "escaped.txt");
    await writeFile(target, "private content");
    await symlink(target, link);

    await expect(
      readBoundedCodexRemoteWorkspaceFile({
        client: createLocalCommandClient(),
        path: link,
        maxBytes: 64,
      }),
    ).rejects.toThrow("symbolic links are not allowed");
  });

  it("rejects parent symbolic links escaping the remote workspace", async () => {
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codex-remote-external-"));
    try {
      const externalFile = path.join(externalRoot, "private.txt");
      await writeFile(externalFile, "private remote content");
      const link = path.join(localWorkspaceRoot, "linked-directory");
      await symlink(externalRoot, link);

      await expect(
        readBoundedCodexRemoteWorkspaceFile({
          client: createLocalCommandClient(),
          path: path.join(link, "private.txt"),
          maxBytes: 64,
          workspaceRoot: localWorkspaceRoot,
        }),
      ).rejects.toThrow("file escapes remote workspace");
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed, truncated, and oversized command responses", async () => {
    for (const stdout of ["not valid base64!", "YQ", "YWJjZA=="]) {
      const client = {
        request: vi.fn(async () => ({ exitCode: 0, stdout, stderr: "" })),
      };
      await expect(
        readBoundedCodexRemoteWorkspaceFile({ client, path: "/remote/report.txt", maxBytes: 3 }),
      ).rejects.toThrow(/invalid|oversized|exceeds/);
    }
  });

  it("reports the documented remote Node.js prerequisite clearly", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error("failed to spawn command: No such file or directory");
      }),
    };

    await expect(
      readBoundedCodexRemoteWorkspaceFile({ client, path: "/remote/report.txt", maxBytes: 64 }),
    ).rejects.toThrow("requires Node.js on the remote app-server host");
  });

  it("honors cancellation before issuing a native command", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createLocalCommandClient();

    await expect(
      readBoundedCodexRemoteWorkspaceFile({
        client,
        path: "/remote/report.txt",
        maxBytes: 64,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe("prepareCodexRemoteWorkspaceMessageMedia", () => {
  it.each([
    { remoteRoot: remoteWorkspaceRoot, reportAlias: "reports/./slack-upload.txt" },
    { remoteRoot: "C:/Work/Repo", reportAlias: "c:\\work\\repo\\reports\\slack-upload.txt" },
  ])(
    "stages scalar, list, and structured attachments from $remoteRoot",
    async ({ remoteRoot, reportAlias }) => {
      const reportPath = `${remoteRoot}/reports/slack-upload.txt`;
      const imagePath = `${remoteRoot}/images/preview.png`;
      const readRemoteFile = createRemoteFileReader({
        [reportPath]: "authoritative remote report\n",
        [imagePath]: "authoritative remote image\n",
      });

      const result = await prepareCodexRemoteWorkspaceMessageMedia({
        args: {
          action: "upload-file",
          filePath: reportAlias,
          mediaUrls: ["reports/slack-upload.txt", "https://example.com/image.png"],
          attachments: [{ filePath: imagePath, title: "Preview" }],
        },
        localWorkspaceRoot,
        remoteWorkspaceRoot: remoteRoot,
        readRemoteFile,
      });
      const stagedReportPath = result.args.filePath;
      const stagedImagePath = (result.args.attachments as Array<{ filePath: string }>)[0]?.filePath;

      expect(result.args).toEqual({
        action: "upload-file",
        filePath: stagedReportPath,
        mediaUrls: [stagedReportPath, "https://example.com/image.png"],
        attachments: [{ filePath: stagedImagePath, title: "Preview" }],
      });
      expect(result.sourcePathsByStagedPath.size).toBe(2);
      expect(new Set(result.sourcePathsByStagedPath.get(String(stagedReportPath)))).toEqual(
        new Set([reportAlias, reportPath, "reports/slack-upload.txt"]),
      );
      expect(result.sourcePathsByStagedPath.get(String(stagedImagePath))).toEqual([imagePath]);
      expect(readRemoteFile).toHaveBeenCalledTimes(2);
      expect(stagedReportPath).toContain(`${path.sep}media${path.sep}outbound${path.sep}`);
      await expect(readFile(String(stagedReportPath), "utf8")).resolves.toBe(
        "authoritative remote report\n",
      );
      await expect(readFile(String(stagedImagePath), "utf8")).resolves.toBe(
        "authoritative remote image\n",
      );
    },
  );

  it("uses authoritative remote bytes even when a stale local file has the same timestamp", async () => {
    const remotePath = `${remoteWorkspaceRoot}/reused-upload.txt`;
    await writeFile(path.join(localWorkspaceRoot, "reused-upload.txt"), "stale local content\n");

    const result = await prepareCodexRemoteWorkspaceMessageMedia({
      args: { filePath: remotePath },
      localWorkspaceRoot,
      remoteWorkspaceRoot,
      readRemoteFile: createRemoteFileReader({ [remotePath]: "authoritative remote content\n" }),
    });

    await expect(readFile(String(result.args.filePath), "utf8")).resolves.toBe(
      "authoritative remote content\n",
    );
  });

  it("transfers newly generated remote files without waiting for workspace synchronization", async () => {
    const remotePath = `${remoteWorkspaceRoot}/reports/new-upload.txt`;

    const result = await prepareCodexRemoteWorkspaceMessageMedia({
      args: { filePath: remotePath },
      localWorkspaceRoot,
      remoteWorkspaceRoot,
      readRemoteFile: createRemoteFileReader({ [remotePath]: "new remote attachment\n" }),
    });

    await expect(readFile(String(result.args.filePath), "utf8")).resolves.toBe(
      "new remote attachment\n",
    );
  });

  it("preserves the original argument object for URL-backed media", async () => {
    const args = {
      action: "send",
      mediaUrl: "https://example.com/image.png",
      attachments: [{ fileUrl: "media://inbound/image.png" }],
    };

    for (const remoteRoot of [remoteWorkspaceRoot, undefined]) {
      const result = await prepareCodexRemoteWorkspaceMessageMedia({
        args,
        localWorkspaceRoot,
        remoteWorkspaceRoot: remoteRoot,
      });
      expect(result.args).toBe(args);
      expect(result.sourcePathsByStagedPath.size).toBe(0);
    }
  });

  it("preserves securely validated Gateway-owned media in a remote run", async () => {
    const saved = await saveMediaBuffer(
      Buffer.from("previously downloaded Gateway media\n"),
      "text/plain",
      "inbound",
      1_024,
      "download.txt",
    );
    const args = { action: "send", filePath: saved.path };
    const readRemoteFile = createRemoteFileReader({});

    const result = await prepareCodexRemoteWorkspaceMessageMedia({
      args,
      localWorkspaceRoot,
      remoteWorkspaceRoot,
      readRemoteFile,
    });
    expect(result.args).toBe(args);
    expect(result.sourcePathsByStagedPath.size).toBe(0);
    expect(readRemoteFile).not.toHaveBeenCalled();
  });

  it("rejects symlinks disguised as Gateway-owned media", async () => {
    const saved = await saveMediaBuffer(
      Buffer.from("old Gateway media\n"),
      "text/plain",
      "inbound",
      1_024,
      "replaceable.txt",
    );
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codex-media-external-"));
    try {
      const externalPath = path.join(externalRoot, "private.txt");
      await writeFile(externalPath, "gateway-local private data\n");
      await unlink(saved.path);
      await symlink(externalPath, saved.path);
      const readRemoteFile = createRemoteFileReader({});

      await expect(
        prepareCodexRemoteWorkspaceMessageMedia({
          args: { filePath: saved.path },
          localWorkspaceRoot,
          remoteWorkspaceRoot,
          readRemoteFile,
        }),
      ).rejects.toThrow();
      expect(readRemoteFile).not.toHaveBeenCalled();
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when remote transfers have no active app-server client", async () => {
    await expect(
      prepareCodexRemoteWorkspaceMessageMedia({
        args: { filePath: `${remoteWorkspaceRoot}/reports/report.txt` },
        localWorkspaceRoot,
        remoteWorkspaceRoot,
      }),
    ).rejects.toThrow("requires an active app-server client");
  });

  it("propagates missing remote files before invoking a channel uploader", async () => {
    await expect(
      prepareCodexRemoteWorkspaceMessageMedia({
        args: { filePath: `${remoteWorkspaceRoot}/reports/missing.txt` },
        localWorkspaceRoot,
        remoteWorkspaceRoot,
        readRemoteFile: createRemoteFileReader({}),
      }),
    ).rejects.toThrow("does not exist");
  });

  it("rejects gateway-local paths and traversal before issuing a remote request", async () => {
    for (const filePath of ["/etc/passwd", `${remoteWorkspaceRoot}/reports/../../private.txt`]) {
      const readRemoteFile = createRemoteFileReader({});
      await expect(
        prepareCodexRemoteWorkspaceMessageMedia({
          args: { filePath },
          localWorkspaceRoot,
          remoteWorkspaceRoot,
          readRemoteFile,
        }),
      ).rejects.toThrow(/outside|must stay inside/);
      expect(readRemoteFile).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized remote files before handing bytes to the channel uploader", async () => {
    const remotePath = `${remoteWorkspaceRoot}/reports/oversized.txt`;
    await expect(
      prepareCodexRemoteWorkspaceMessageMedia({
        args: { filePath: remotePath },
        localWorkspaceRoot,
        remoteWorkspaceRoot,
        readRemoteFile: createRemoteFileReader({ [remotePath]: "too many bytes" }),
        maxBytes: 3,
      }),
    ).rejects.toThrow("limit of 3 bytes");
  });

  it("enforces one aggregate byte limit across remote attachments", async () => {
    const first = `${remoteWorkspaceRoot}/reports/first.txt`;
    const second = `${remoteWorkspaceRoot}/reports/second.txt`;
    await expect(
      prepareCodexRemoteWorkspaceMessageMedia({
        args: { mediaUrls: [first, second] },
        localWorkspaceRoot,
        remoteWorkspaceRoot,
        readRemoteFile: createRemoteFileReader({ [first]: "abc", [second]: "def" }),
        maxBytes: 5,
      }),
    ).rejects.toThrow("limit of 2 bytes");
  });

  it.each([
    { elapsedMs: 100.25, budgets: [500, 399], expires: false },
    { elapsedMs: 499.75, budgets: [500], expires: true },
  ])("keeps batch deadlines across a clock rewind ($elapsedMs)", async (test) => {
    let elapsed = 0;
    let wallClock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    const first = `${remoteWorkspaceRoot}/reports/first.txt`;
    const second = `${remoteWorkspaceRoot}/reports/second.txt`;
    const readRemoteFile = vi.fn<CodexRemoteWorkspaceFileReader>(async ({ path: remotePath }) => {
      elapsed = test.elapsedMs;
      wallClock -= 5_000;
      return {
        dataBase64: Buffer.from(remotePath === first ? "first" : "second").toString("base64"),
      };
    });
    const transfer = prepareCodexRemoteWorkspaceMessageMedia({
      args: { mediaUrls: [first, second] },
      localWorkspaceRoot,
      remoteWorkspaceRoot,
      readRemoteFile,
      timeoutMs: 500,
    });
    if (test.expires) {
      await expect(transfer).rejects.toThrow("timed out");
    } else {
      await transfer;
    }
    expect(readRemoteFile.mock.calls.map(([params]) => params.timeoutMs)).toEqual(test.budgets);
  });

  it("counts repeated attachment entries before issuing any remote request", async () => {
    const remotePath = `${remoteWorkspaceRoot}/reports/report.txt`;
    const readRemoteFile = createRemoteFileReader({ [remotePath]: "report" });
    for (const args of [
      { mediaUrls: Array.from({ length: 17 }, () => remotePath) },
      { attachments: Array.from({ length: 17 }, () => ({ filePath: remotePath })) },
    ]) {
      await expect(
        prepareCodexRemoteWorkspaceMessageMedia({
          args,
          localWorkspaceRoot,
          remoteWorkspaceRoot,
          readRemoteFile,
        }),
      ).rejects.toThrow("16-attachment limit");
      expect(readRemoteFile).not.toHaveBeenCalled();
    }
  });

  it("keeps staged media immutable after the remote source changes", async () => {
    const remotePath = `${remoteWorkspaceRoot}/reports/immutable-upload.txt`;
    const remoteFiles = { [remotePath]: "immutable transferred report\n" };
    const result = await prepareCodexRemoteWorkspaceMessageMedia({
      args: { filePath: remotePath },
      localWorkspaceRoot,
      remoteWorkspaceRoot,
      readRemoteFile: createRemoteFileReader(remoteFiles),
    });
    remoteFiles[remotePath] = "changed remote content\n";

    await expect(readFile(String(result.args.filePath), "utf8")).resolves.toBe(
      "immutable transferred report\n",
    );
  });

  it("honors cancellation before requesting remote bytes", async () => {
    const controller = new AbortController();
    controller.abort();
    const readRemoteFile = createRemoteFileReader({});

    await expect(
      prepareCodexRemoteWorkspaceMessageMedia({
        args: { filePath: `${remoteWorkspaceRoot}/reports/missing.txt` },
        localWorkspaceRoot,
        remoteWorkspaceRoot,
        readRemoteFile,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(readRemoteFile).not.toHaveBeenCalled();
  });
});
