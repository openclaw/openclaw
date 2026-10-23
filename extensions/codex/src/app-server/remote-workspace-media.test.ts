import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createNativeSessionBindingAuthority,
  prepareNativeSessionGenerationAuthority,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RemoteWorkspaceFileReader } from "openclaw/plugin-sdk/file-access-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexRemoteWorkspaceFileReader,
  prepareCodexRemoteWorkspaceMessageMedia,
} from "./remote-workspace-media.js";
import { createClientHarness } from "./test-support.js";

const remoteWorkspaceRoot = "/remote/codex-workspace";
const readPath = "/remote/report.txt";
const batchPaths = ["first", "second"].map((name) => `${remoteWorkspaceRoot}/reports/${name}.txt`);
let openClawState: OpenClawTestState;
type MediaOptions = Parameters<typeof prepareCodexRemoteWorkspaceMessageMedia>[0];
type ExecClient = Parameters<typeof createCodexRemoteWorkspaceFileReader>[0];

beforeEach(async () => {
  openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "codex-remote-workspace-media-",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
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
      throw new Error(`Remote artifact exceeds the limit of ${maxBytes} bytes.`);
    }
    return buffer;
  });
}

function prepareMedia(
  args: Record<string, unknown>,
  readRemoteFile?: RemoteWorkspaceFileReader,
  options: Omit<MediaOptions, "args" | "readRemoteFile"> = {},
) {
  return prepareCodexRemoteWorkspaceMessageMedia({
    args,
    localWorkspaceRoot: openClawState.workspaceDir,
    remoteWorkspaceRoot,
    readRemoteFile,
    ...options,
  });
}

const saveInbound = (content: string, name: string) =>
  saveMediaBuffer(Buffer.from(content), "text/plain", "inbound", 1_024, name);
const readText = (filePath: unknown) => readFile(String(filePath), "utf8");
const execResult = (stdout: string, exitCode = 0, stderr = "") => ({ exitCode, stdout, stderr });
const readFrom = (request: ExecClient["request"]) =>
  createCodexRemoteWorkspaceFileReader(
    { request },
    createNativeSessionBindingAuthority([], vi.fn()),
  );

async function expectNoRead(
  args: Record<string, unknown>,
  error?: string | RegExp,
  options: Parameters<typeof prepareMedia>[2] = {},
) {
  const readRemoteFile = createRemoteFileReader({});
  await expect(prepareMedia(args, readRemoteFile, options)).rejects.toThrow(error);
  expect(readRemoteFile).not.toHaveBeenCalled();
}

describe("Codex remote file transport", () => {
  it.each([
    [async () => execResult("", 1, "ENOENT: missing report.txt"), "file read failed: ENOENT"],
    [
      async () => {
        throw new Error("failed to spawn command: No such file or directory");
      },
      "requires Node.js on the remote app-server host",
    ],
  ] as const)(
    "distinguishes remote file failures from missing Node.js: %s",
    async (request, message) => {
      const read = readFrom(request);
      await expect(read({ path: readPath, maxBytes: 64 })).rejects.toThrow(message);
    },
  );

  it.each(["current", "before first chunk", "between chunks", "before final response"] as const)(
    "checks persisted lineage at remote file dispatch and completion (%s)",
    async (stage) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:remote-file-authority",
        storePath: path.join(openClawState.sessionsDir(), "sessions.json"),
      };
      const store = (sessionId: string, updatedAt: number) =>
        upsertSessionEntry({ ...scope, entry: { sessionId, updatedAt } });
      await store("reader-origin", 1);
      const captured = await prepareNativeSessionGenerationAuthority({
        target: { ...scope, sessionId: "reader-origin" },
        storePath: scope.storePath,
        createSupersededError: () => new Error("Remote file source was replaced"),
      });
      expect(captured.state).toBe("current");
      const replace = () => store("reader-successor", 2);
      const holdFirstReply = stage === "between chunks" || stage === "before final response";
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
          expect(request.params).toMatchObject({ env: { NODE_OPTIONS: null, NODE_PATH: null } });
          expect(request.params).not.toHaveProperty("outputBytesCap");
          const offset = Number(request.params.command[6]);
          const stdout = JSON.stringify({
            dataBase64: bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
            size: bytes.length,
            revision: "same-file",
          });
          const reply = () => send({ id: request.id, result: execResult(stdout) });
          if (offset === 0 && holdFirstReply) {
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
        transfer = read({ path: readPath, maxBytes: bytes.length });
        if (holdFirstReply) {
          const reply = await awaitGateBeforeSettlement(
            firstReply.promise,
            transfer.catch(() => undefined),
            "Remote file read settled before its first command",
          );
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
  it("stages scalar, list, and structured attachments from C:/Work/Repo", async () => {
    const remoteRoot = "C:/Work/Repo";
    const reportAlias = "c:\\work\\repo\\reports\\slack-upload.txt";
    const reportPath = `${remoteRoot}/reports/slack-upload.txt`;
    const imagePath = `${remoteRoot}/images/preview.png`;
    const localReport = path.join(openClawState.workspaceDir, "reports", "slack-upload.txt");
    await mkdir(path.dirname(localReport), { recursive: true });
    await writeFile(localReport, "stale local report\n");
    const readRemoteFile = createRemoteFileReader({
      [reportPath]: "authoritative remote report\n",
      [imagePath]: "authoritative remote image\n",
    });

    const { args, sourcePathsByStagedPath: sources } = await prepareMedia(
      {
        action: "upload-file",
        filePath: reportAlias,
        mediaUrls: ["reports/slack-upload.txt", "https://example.com/image.png"],
        attachments: [{ filePath: imagePath, title: "Preview" }],
      },
      readRemoteFile,
      { remoteWorkspaceRoot: remoteRoot },
    );
    const report = args.filePath;
    const image = (args.attachments as Array<{ filePath: string }>)[0]?.filePath;

    expect(args).toEqual({
      action: "upload-file",
      filePath: report,
      mediaUrls: [report, "https://example.com/image.png"],
      attachments: [{ filePath: image, title: "Preview" }],
    });
    expect(sources.size).toBe(2);
    expect(new Set(sources.get(String(report)))).toEqual(
      new Set([reportAlias, reportPath, "reports/slack-upload.txt"]),
    );
    expect(sources.get(String(image))).toEqual([imagePath]);
    expect(readRemoteFile).toHaveBeenCalledTimes(2);
    expect(report).toContain(`${path.sep}media${path.sep}outbound${path.sep}`);
    await expect(readText(report)).resolves.toBe("authoritative remote report\n");
    await expect(readText(image)).resolves.toBe("authoritative remote image\n");
  });

  it("preserves the original argument object for URL-backed media", async () => {
    const args = {
      action: "send",
      mediaUrl: "https://example.com/image.png",
      attachments: [{ fileUrl: "media://inbound/image.png" }],
    };

    for (const remoteRoot of [remoteWorkspaceRoot, undefined]) {
      const result = await prepareMedia(args, undefined, { remoteWorkspaceRoot: remoteRoot });
      expect(result.args).toBe(args);
      expect(result.sourcePathsByStagedPath.size).toBe(0);
    }
  });

  it("preserves securely validated Gateway-owned media in a remote run", async () => {
    const saved = await saveInbound("previously downloaded Gateway media\n", "download.txt");
    const args = { action: "send", filePath: saved.path };
    const readRemoteFile = createRemoteFileReader({});

    const result = await prepareMedia(args, readRemoteFile);
    expect(result.args).toBe(args);
    expect(result.sourcePathsByStagedPath.size).toBe(0);
    expect(readRemoteFile).not.toHaveBeenCalled();
  });

  it("rejects symlinks disguised as Gateway-owned media", async () => {
    const saved = await saveInbound("old Gateway media\n", "replaceable.txt");
    const externalPath = path.join(openClawState.workspaceDir, "private.txt");
    await writeFile(externalPath, "private\n");
    await unlink(saved.path);
    await symlink(externalPath, saved.path);
    await expectNoRead({ filePath: saved.path });
  });

  it("fails closed when remote transfers have no active app-server client", async () => {
    await expect(
      prepareMedia({ filePath: `${remoteWorkspaceRoot}/reports/report.txt` }),
    ).rejects.toThrow("requires an active app-server client");
  });

  it("rejects gateway-local paths and traversal before issuing a remote request", async () => {
    for (const filePath of ["/etc/passwd", `${remoteWorkspaceRoot}/reports/../../private.txt`]) {
      await expectNoRead({ filePath }, /outside|must stay inside/);
    }
  });

  it("enforces one aggregate byte limit across remote attachments", async () => {
    await expect(
      prepareMedia(
        { mediaUrls: batchPaths },
        createRemoteFileReader(Object.fromEntries(batchPaths.map((file) => [file, "abc"]))),
        { maxBytes: 5 },
      ),
    ).rejects.toThrow("limit of 2 bytes");
  });

  it("keeps batch deadlines across a clock rewind (499.75)", async () => {
    let elapsed = 0;
    let wallClock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    const readRemoteFile = vi.fn<RemoteWorkspaceFileReader>(async () => {
      elapsed = 499.75;
      wallClock -= 5_000;
      return Buffer.from("first");
    });
    await expect(
      prepareMedia({ mediaUrls: batchPaths }, readRemoteFile, { timeoutMs: 500 }),
    ).rejects.toThrow("timed out");
    expect(readRemoteFile.mock.calls.map(([params]) => params.timeoutMs)).toEqual([500]);
  });

  it("counts repeated attachment entries before issuing any remote request", async () => {
    const remotePath = `${remoteWorkspaceRoot}/reports/report.txt`;
    for (const args of [
      { mediaUrls: Array.from({ length: 17 }, () => remotePath) },
      { attachments: Array.from({ length: 17 }, () => ({ filePath: remotePath })) },
    ]) {
      await expectNoRead(args, "16-attachment limit");
    }
  });

  it("honors cancellation before requesting remote bytes", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectNoRead({ filePath: `${remoteWorkspaceRoot}/reports/missing.txt` }, undefined, {
      signal: controller.signal,
    });
  });
});
