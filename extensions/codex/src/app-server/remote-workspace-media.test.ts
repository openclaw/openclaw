import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createNativeSessionBindingAuthority,
  prepareNativeSessionGenerationAuthority,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RemoteWorkspaceFileReader } from "openclaw/plugin-sdk/file-access-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexRemoteWorkspaceFileReader,
  prepareCodexRemoteWorkspaceMessageMedia,
} from "./remote-workspace-media.js";
import { createClientHarness } from "./test-support.js";

const remoteWorkspaceRoot = "/remote/codex-workspace";
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
  return vi.fn<RemoteWorkspaceFileReader>(async ({ path: remotePath, maxBytes, signal }) => {
    signal?.throwIfAborted();
    const content = files[remotePath];
    if (content === undefined) {
      throw new Error(`Codex remote workspace artifact does not exist: ${remotePath}`);
    }
    const buffer = Buffer.from(content);
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Codex remote workspace artifact exceeds the limit of ${maxBytes} bytes.`);
    }
    return buffer;
  });
}

describe("Codex remote file transport", () => {
  it("retains the implicit Windows output cap and scrubs Node preload variables", async () => {
    const bytes = Buffer.alloc(512 * 1024 + 17, 0x61);
    const request = vi.fn(async (_method: string, params: { command: string[] }) => {
      const offset = Number(params.command[6]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          dataBase64: bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
          size: bytes.length,
          revision: "same-file",
        }),
        stderr: "",
      };
    });
    const read = createCodexRemoteWorkspaceFileReader(
      { request },
      createNativeSessionBindingAuthority([], vi.fn()),
    );
    expect(await read({ path: "/remote/report.txt", maxBytes: bytes.length })).toEqual(bytes);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [method, params] of request.mock.calls) {
      expect(method).toBe("command/exec");
      expect(params).toMatchObject({ env: { NODE_OPTIONS: null, NODE_PATH: null } });
      expect(params).not.toHaveProperty("outputBytesCap");
    }
  });

  it("distinguishes missing files from a missing Node.js executable", async () => {
    const request = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ENOENT: missing report.txt",
    }));
    const read = createCodexRemoteWorkspaceFileReader(
      { request },
      createNativeSessionBindingAuthority([], vi.fn()),
    );
    await expect(read({ path: "/remote/report.txt", maxBytes: 64 })).rejects.toThrow(
      "file read failed: ENOENT",
    );
  });

  it("reports the remote Node.js prerequisite clearly", async () => {
    const request = vi.fn(async () => {
      throw new Error("failed to spawn command: No such file or directory");
    });
    const read = createCodexRemoteWorkspaceFileReader(
      { request },
      createNativeSessionBindingAuthority([], vi.fn()),
    );
    await expect(read({ path: "/remote/report.txt", maxBytes: 64 })).rejects.toThrow(
      "requires Node.js on the remote app-server host",
    );
  });

  it.each(["current", "before first chunk", "between chunks", "before final response"] as const)(
    "checks persisted lineage at remote file dispatch and completion (%s)",
    async (stage) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:remote-file-authority",
        storePath: path.join(openClawState.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntry({
        ...scope,
        entry: { sessionId: "reader-origin", updatedAt: 1 },
      });
      const captured = await prepareNativeSessionGenerationAuthority({
        target: { ...scope, sessionId: "reader-origin" },
        storePath: scope.storePath,
        createSupersededError: () => new Error("Remote file source was replaced"),
      });
      expect(captured.state).toBe("current");
      const replace = () =>
        upsertSessionEntry({
          ...scope,
          entry: { sessionId: "reader-successor", updatedAt: 2 },
        });
      const bytes = Buffer.alloc(stage === "before final response" ? 17 : 512 * 1024 + 17, 0x61);
      const firstReply = createDeferred<() => void>();
      const harness = createClientHarness({
        onWrite(line, send) {
          const request = JSON.parse(line) as {
            id: number;
            method: string;
            params: { command: string[] };
          };
          expect(request.method).toBe("command/exec");
          const offset = Number(request.params.command[6]);
          const reply = () =>
            send({
              id: request.id,
              result: {
                exitCode: 0,
                stdout: JSON.stringify({
                  dataBase64: bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
                  size: bytes.length,
                  revision: "same-file",
                }),
                stderr: "",
              },
            });
          if (offset === 0 && (stage === "between chunks" || stage === "before final response")) {
            firstReply.resolve(reply);
          } else {
            reply();
          }
        },
      });
      let transfer: Promise<Buffer> | undefined;
      try {
        if (stage === "before first chunk") {
          await replace();
        }
        const read = createCodexRemoteWorkspaceFileReader(harness.client, captured.authority);
        transfer = read({ path: "/remote/report.txt", maxBytes: bytes.length });
        const settled = transfer.then(
          () => undefined,
          () => undefined,
        );
        if (stage === "between chunks" || stage === "before final response") {
          const reply = await Promise.race([
            firstReply.promise,
            settled.then(() => {
              throw new Error("Remote file read settled before its first command");
            }),
          ]);
          // The worker admission must end before awaiting the native response.
          await replace();
          reply();
        }
        if (stage === "current") {
          await expect(transfer).resolves.toEqual(bytes);
        } else {
          await expect(transfer).rejects.toThrow("Remote file source was replaced");
        }
        expect(harness.writes).toHaveLength(
          stage === "current" ? 2 : stage === "before first chunk" ? 0 : 1,
        );
        expect(harness.client.getCloseError()).toBeUndefined();
      } finally {
        harness.client.close();
        await Promise.allSettled([transfer]);
      }
    },
  );
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
    const readRemoteFile = vi.fn<RemoteWorkspaceFileReader>(async ({ path: remotePath }) => {
      elapsed = test.elapsedMs;
      wallClock -= 5_000;
      return Buffer.from(remotePath === first ? "first" : "second");
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
