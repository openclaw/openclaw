import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDirFetch } from "../node-host/dir-fetch.js";
import { appendFileTransferAudit } from "./audit.js";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";
import {
  EXISTING_BINDING,
  WRITE_BINDING,
  archiveMetadata,
  mockDirFetchArchive,
  tarEntries,
  createCtx,
  expectRecordFields,
  expectResultFields,
  requireInvokeParams,
  requireRecord,
} from "./node-invoke-policy.test-support.js";
import * as filePolicy from "./policy.js";
import { persistLiteralGrant } from "./policy.js";
const policy = createFileTransferNodeInvokePolicy();

function approval(decision: "allow-once" | "allow-always", id = "approval-1") {
  return { request: vi.fn(async (_request: unknown) => ({ id, decision })) };
}

function nodeConfig(node: Record<string, unknown>) {
  return { nodes: { "node-1": node } };
}

function literalGrant(
  requestedPath: string,
  canonicalPath = requestedPath,
  command = "file.fetch",
) {
  return { nodeId: "node-1", command, requestedPath, canonicalPath };
}

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

vi.mock("./policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policy.js")>();
  return {
    ...actual,
    persistLiteralGrant: vi.fn(async () => undefined),
  };
});

beforeEach(() => setRuntimeConfigSnapshot({}));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.mocked(persistLiteralGrant).mockReset();
  vi.mocked(persistLiteralGrant).mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("./audit.js");
  vi.doUnmock("./policy.js");
  vi.resetModules();
});

describe("file-transfer node invoke policy", () => {
  it("denies raw node.invoke before the node when plugin policy is missing", async () => {
    const { ctx, invokeNode } = createCtx({ pluginConfig: {} });

    expectResultFields(await policy.handle(ctx), { ok: false, code: "NO_POLICY" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("uses exact allow-once plugin approval once across preflight and final invoke", async () => {
    const approvals = approval("allow-once");
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: nodeConfig({
        ask: "on-miss",
        allowReadPaths: ["/allowed/**"],
        maxBytes: 256,
        followSymlinks: true,
      }),
      approvals,
    });

    expect((await policy.handle(ctx)).ok).toBe(true);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    const approvalCalls = approvals.request.mock.calls as unknown[][];
    const approvalRequest = requireRecord(approvalCalls[0]?.[0], "approval request");
    expectRecordFields(approvalRequest, {
      title: "Read file: /tmp/new.txt",
      severity: "info",
      toolName: "file.fetch",
    });
    expect(approvalRequest.description).toContain(
      '"allow-always" saves this exact command and path for this node',
    );
    const params = { path: "/tmp/new.txt", followSymlinks: true, maxBytes: 256 };
    expect(invokeNode).toHaveBeenNthCalledWith(2, {
      params: {
        ...params,
        expectedCanonicalPath: "/tmp/new.txt",
        expectedBinding: EXISTING_BINDING,
      },
    });

    expect(persistLiteralGrant).not.toHaveBeenCalled();
  });

  it("returns an actionable warning when the operation succeeds but persistence fails", async () => {
    vi.mocked(persistLiteralGrant).mockRejectedValueOnce(new Error("config changed"));
    const { ctx } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: nodeConfig({ ask: "on-miss" }),
      approvals: approval("allow-always"),
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(requireRecord(requireRecord(result, "result").payload, "payload")).toHaveProperty(
      "standingApprovalWarning",
    );
  });

  it("reuses an exact literal grant and reapproves canonical drift", async () => {
    const approvals = approval("allow-always", "approval-2");
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/report-*.txt" },
      pluginConfig: {
        policyVersion: 2,
        nodes: { "node-1": { ask: "on-miss" } },
        literalGrants: [literalGrant("/tmp/report-*.txt")],
      },
      approvals,
    });

    expect((await policy.handle(ctx)).ok).toBe(true);
    expect(approvals.request).not.toHaveBeenCalled();

    invokeNode.mockReset();
    invokeNode.mockResolvedValue(nodePayload("/tmp/other.txt", {}));
    expect((await policy.handle(ctx)).ok).toBe(true);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(persistLiteralGrant).toHaveBeenCalledWith({
      ...literalGrant("/tmp/report-*.txt", "/tmp/other.txt"),
      pendingReapprovalSelector: undefined,
    });
  });

  it.each([
    ["deny", "APPROVAL_DENIED", "operator denied the prompt"],
    [undefined, "APPROVAL_UNAVAILABLE", "no operator client connected to approve the request"],
    ["accept", "APPROVAL_DENIED", "invalid approval decision"],
  ])("fails closed for decision %s", async (decision, code, reason) => {
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision })),
    } as unknown as NonNullable<OpenClawPluginNodeInvokePolicyContext["approvals"]>;
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: nodeConfig({ ask: "on-miss", allowReadPaths: ["/allowed/**"] }),
      approvals,
    });

    expectResultFields(await policy.handle(ctx), {
      ok: false,
      code,
      message: `file.fetch ${code}: ${reason}`,
    });
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("marks node transport failures as unavailable", async () => {
    const { ctx, invokeNode } = createCtx({ params: { path: "/tmp/file.txt" } });
    invokeNode.mockResolvedValueOnce({
      ok: false,
      code: "TIMEOUT",
      message: "node timed out",
      details: { nodeError: { code: "TIMEOUT" } },
    });

    expectResultFields(await policy.handle(ctx), {
      ok: false,
      code: "TIMEOUT",
      unavailable: true,
      details: { nodeError: { code: "TIMEOUT" } },
    });
  });

  it("refuses restricted writes before mutation when an old node ignores hardlink rejection", async () => {
    const { ctx, invokeNode } = createCtx({
      command: "file.write",
      params: {
        path: "/tmp/AGENTS.md",
        contentBase64: Buffer.from("payload").toString("base64"),
        overwrite: true,
        rejectHardlinks: true,
      },
    });

    expectResultFields(await policy.handle(ctx), {
      ok: false,
      code: "HARDLINK_REJECTION_UNSUPPORTED",
    });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      preflightOnly: true,
      rejectHardlinks: true,
      followSymlinks: false,
    });
  });
  it("checks file.write canonical policy before the mutating node call", async () => {
    const { ctx, invokeNode } = createCtx({
      command: "file.write",
      params: {
        path: "/tmp/link/out.txt",
        contentBase64: Buffer.from("payload").toString("base64"),
        createParents: true,
      },
      pluginConfig: nodeConfig({ allowWritePaths: ["/tmp/**"], followSymlinks: true }),
    });
    invokeNode.mockResolvedValueOnce(nodePayload("/etc/out.txt", { binding: WRITE_BINDING }));

    expectResultFields(await policy.handle(ctx), { ok: false, code: "SYMLINK_TARGET_DENIED" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(requireInvokeParams(invokeNode, 0).preflightOnly).toBe(true);
  });
});

const testUnlessWindows = process.platform === "win32" ? it.skip : it;

function directoryContext(
  root: string,
  nodePolicy?: Record<string, unknown>,
  overrides: Parameters<typeof createCtx>[0] = {},
) {
  return createCtx({
    command: "dir.fetch",
    params: { path: root },
    ...(nodePolicy ? { pluginConfig: nodeConfig(nodePolicy) } : {}),
    ...overrides,
  });
}

function nodePayload(root: string, fields: Record<string, unknown>) {
  return {
    ok: true as const,
    payload: { ok: true, binding: EXISTING_BINDING, path: root, ...fields },
  };
}

async function expectPreflightRejection(fields: Record<string, unknown>, code: string) {
  const { ctx, invokeNode } = cappedDirectoryContext();
  invokeNode.mockResolvedValueOnce(nodePayload("/home/me", { preflightOnly: true, ...fields }));
  expectResultFields(await policy.handle(ctx), { ok: false, code });
  expect(invokeNode).toHaveBeenCalledTimes(1);
}

function cappedDirectoryContext() {
  return directoryContext("/home/me", { allowReadPaths: ["/home/me", "/home/me/**"] });
}

function files(count: number, name = (index: number) => `file-${index}.txt`, contents = "") {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [name(index), contents]));
}

function mockFinalArchive(
  invokeNode: ReturnType<typeof createCtx>["invokeNode"],
  fields: Record<string, unknown>,
) {
  invokeNode
    .mockResolvedValueOnce(
      nodePayload("/tmp/project", { entries: ["a.txt"], fileCount: 1, preflightOnly: true }),
    )
    .mockResolvedValueOnce(nodePayload("/tmp/project", fields));
}

describe("file-transfer dir.fetch archive policy", () => {
  it.each([
    [{ fileCount: 2 }, "PREFLIGHT_ENTRIES_MISSING"],
    [{ entries: ["ok.txt", "/etc/passwd"], fileCount: 2 }, "PREFLIGHT_ENTRY_INVALID"],
    [{ entries: Object.keys(files(5001)), fileCount: 5001 }, "PREFLIGHT_ENTRIES_TOO_MANY"],
  ] as const)("rejects preflight %j with %s before fetching", expectPreflightRejection);

  testUnlessWindows("rejects mismatched dir.fetch archive integrity metadata", async () => {
    const tarBase64 = tarEntries({ "a.txt": "a" });
    const { ctx, invokeNode } = directoryContext("/tmp/project");
    mockFinalArchive(invokeNode, { tarBase64, tarBytes: 1, sha256: "c".repeat(64), fileCount: 1 });

    expectResultFields(await policy.handle(ctx), { ok: false, code: "ARCHIVE_SIZE_MISMATCH" });
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "dir.fetch",
        decision: "error",
        errorCode: "ARCHIVE_SIZE_MISMATCH",
      }),
    );
  });

  it("rejects final dir.fetch archives with a denied implicit parent directory", async () => {
    const root = "C:\\transfer";
    const deniedPath = "C:\\transfer\\private";
    const approvals = approval("allow-always");
    const { ctx, invokeNode } = directoryContext(
      root,
      { ask: "always", denyPaths: [deniedPath] },
      { approvals },
    );
    // The untrusted final response has no directory headers; preflight remains enabled.
    mockDirFetchArchive(invokeNode, root, { "private/nested/value.txt": "value" });
    vi.mocked(appendFileTransferAudit).mockClear();

    const result = await policy.handle(ctx);

    expect(requireInvokeParams(invokeNode, 0).preflightOnly).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      code: "PATH_POLICY_DENIED",
      details: { path: deniedPath },
    });
    expect(appendFileTransferAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed" }),
    );
    expect(persistLiteralGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["counts implicit parents", files(2501, (i) => `dir-${i}/file`), false, false],
    ["counts shared parents once", files(4998, (i) => `parent/nested/file-${i}`), false, true],
    ["accepts the producer root header", files(5000), true, true],
  ] as const)("%s at the descendant cap", async (_name, entries, producerRoot, allowed) => {
    const { ctx, invokeNode } = cappedDirectoryContext();
    mockDirFetchArchive(invokeNode, "/home/me", entries, { producerRoot });
    const result = await policy.handle(ctx);

    expect(result).toMatchObject(
      allowed ? { ok: true } : { ok: false, code: "ARCHIVE_ENTRIES_TOO_MANY" },
    );
  });

  testUnlessWindows("rejects oversized final dir.fetch archive entry lists", async () => {
    const tarBase64 = tarEntries(files(5001, undefined, "x"));
    const { ctx, invokeNode } = directoryContext("/tmp/project", {
      allowReadPaths: ["/tmp/project", "/tmp/project/**"],
    });
    mockFinalArchive(invokeNode, { tarBase64, ...archiveMetadata(tarBase64), fileCount: 5001 });

    expectResultFields(await policy.handle(ctx), { ok: false, code: "ARCHIVE_ENTRIES_TOO_MANY" });
  });

  it("rejects final dir.fetch archive responses without readable archive entries", async () => {
    const { ctx, invokeNode } = directoryContext("/tmp/project");
    mockFinalArchive(invokeNode, { tarBytes: 7, sha256: "c".repeat(64), fileCount: 1 });

    expectResultFields(await policy.handle(ctx), { ok: false, code: "ARCHIVE_ENTRIES_MISSING" });
  });
});

const sizeBytes = 50 * 1024 * 1024;
const expectedSha256 = "a".repeat(64);

function fixture(
  command = "file.create",
  params: Record<string, unknown> = {},
  maxBytes = sizeBytes,
) {
  const create = command === "file.create";
  const { ctx, invokeNode } = createCtx({
    command,
    params: {
      path: "/tmp/input",
      ...(create ? { sizeBytes, expectedSha256, createParents: true } : { transport: "binary" }),
      maxBytes: create ? sizeBytes : 32 * 1024 * 1024,
      followSymlinks: !create,
      preflightOnly: true,
      expectedBinding: { forged: true },
      expectedCanonicalPath: "/other",
      ...params,
    },
    pluginConfig: nodeConfig({
      ask: "off",
      allowReadPaths: ["/tmp/**"],
      ...(create ? { allowWritePaths: ["/tmp/**"] } : {}),
      maxBytes,
      followSymlinks: create,
    }),
  });
  invokeNode.mockImplementation(
    async ({ params: forwarded }: Parameters<typeof invokeNode>[0] = {}) =>
      nodePayload("/tmp/input", {
        binding: create ? WRITE_BINDING : EXISTING_BINDING,
        ...(!create || requireRecord(forwarded, "invoke params").preflightOnly === true
          ? {}
          : { status: "created" }),
      }),
  );
  return { ctx, invokeNode };
}

it.each(["file.create", "file.fetch"])("binds %s metadata and policy limits", async (command) => {
  const create = command === "file.create";
  const maxBytes = create ? sizeBytes : 20 * 1024 * 1024;
  const { ctx, invokeNode } = fixture(command, {}, maxBytes);
  expect(await policy.handle(ctx)).toMatchObject(
    create ? { ok: true, payload: { status: "created" } } : { ok: true },
  );
  const preflight = requireInvokeParams(invokeNode, 0);
  const final = requireInvokeParams(invokeNode, 1);
  expect(preflight).toMatchObject({ maxBytes, followSymlinks: false, preflightOnly: true });
  expect(preflight).not.toHaveProperty("expectedBinding");
  expect(final).toMatchObject({
    expectedCanonicalPath: "/tmp/input",
    expectedBinding: create ? WRITE_BINDING : EXISTING_BINDING,
    ...(create ? { expectedSha256 } : { transport: "binary", maxBytes, followSymlinks: false }),
  });
  if (create) {
    expect(preflight.sizeBytes).toBe(sizeBytes);
  }
  expect(final).not.toHaveProperty("preflightOnly");
});

it.each([
  ["file.create", {}, 16 * 1024 * 1024],
  ["file.create", { sizeBytes: -1 }, sizeBytes],
  ["file.create", { expectedSha256: "bad" }, sizeBytes],
  ["file.create", { maxBytes: Infinity }, sizeBytes],
  ["file.fetch", { transport: "other" }, sizeBytes],
  ["file.fetch", { maxBytes: Number.MAX_SAFE_INTEGER + 1 }, sizeBytes],
] as const)("rejects %s metadata %j before dispatch", async (command, params, maxBytes) => {
  const { ctx, invokeNode } = fixture(command, params, maxBytes);
  const approvals = { request: vi.fn() };
  expect(await policy.handle({ ...ctx, approvals })).toMatchObject({
    ok: false,
    code: "INVALID_PARAMS",
  });
  expect(invokeNode).not.toHaveBeenCalled();
  expect(approvals.request).not.toHaveBeenCalled();
});

it("fails closed when a node preflight omits filesystem identity", async () => {
  const { ctx, invokeNode } = createCtx({});
  invokeNode.mockResolvedValue({
    ok: true,
    payload: { ok: true, path: "/tmp/file.txt", size: 1 },
  });
  expect(await policy.handle(ctx)).toMatchObject({
    ok: false,
    code: "FILESYSTEM_IDENTITY_MISSING",
  });
  expect(invokeNode).toHaveBeenCalledOnce();
});
it("dir.list reapproves a stale grant before listing and binds the retry", async () => {
  const events: string[] = [];
  const approvals = {
    request: vi.fn(async () => {
      events.push("approval");
      return { id: "approval-1", decision: "allow-once" as const };
    }),
  };
  const { ctx, invokeNode } = createCtx({
    command: "dir.list",
    params: { path: "/tmp/project", expectedCanonicalPath: "/tmp/injected" },
    pluginConfig: {
      nodes: { "node-1": { ask: "on-miss", followSymlinks: true } },
      literalGrants: [literalGrant("/tmp/project", "/tmp/old-project", "dir.list")],
    },
    approvals,
  });
  invokeNode.mockImplementation(async ({ params }: Parameters<typeof invokeNode>[0] = {}) => {
    const record = requireRecord(params, "invoke params");
    events.push(record.preflightOnly === true ? "preflight" : "list");
    return {
      ok: true,
      payload:
        record.preflightOnly === true && record.expectedCanonicalPath === "/tmp/old-project"
          ? {
              ok: false,
              code: "CANONICAL_PATH_CHANGED",
              message: "canonical path differs from the authorized target",
              canonicalPath: "/tmp/new-project",
            }
          : { ok: true, binding: EXISTING_BINDING, path: "/tmp/new-project", entries: [] },
    };
  });

  expect((await policy.handle(ctx)).ok).toBe(true);
  expect(events).toEqual(["preflight", "approval", "preflight", "list"]);
  expect(requireInvokeParams(invokeNode, 0).expectedCanonicalPath).toBe("/tmp/old-project");
  expect(requireInvokeParams(invokeNode, 1).expectedCanonicalPath).toBe("/tmp/new-project");
  expect(requireInvokeParams(invokeNode, 2)).toMatchObject({
    expectedCanonicalPath: "/tmp/new-project",
    expectedBinding: EXISTING_BINDING,
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createRealDirFetchContext(input: {
  approved: string;
  maxBytes?: number;
  requested?: string;
  denyPaths?: string[];
}) {
  const approvals = {
    request: vi.fn(async () => ({ id: "approval-1", decision: "deny" as const })),
  };
  const { approved, requested = approved, maxBytes = 1024 * 1024, denyPaths } = input;
  const { ctx, invokeNode } = createCtx({
    command: "dir.fetch",
    params: { path: requested, maxBytes },
    pluginConfig: {
      nodes: { "node-1": { ask: "on-miss", followSymlinks: true, maxBytes, denyPaths } },
      literalGrants: [literalGrant(requested, approved, "dir.fetch")],
    },
    approvals,
  });
  invokeNode.mockImplementation(async ({ params }: Parameters<typeof invokeNode>[0] = {}) => ({
    ok: true,
    payload: await handleDirFetch((params ?? {}) as Parameters<typeof handleDirFetch>[0]),
  }));
  return { approvals, ctx, invokeNode };
}

async function extractFetchedArchive(payload: Record<string, unknown>, tempRoot: string) {
  if (typeof payload.tarBase64 !== "string") {
    throw new Error("missing archive bytes");
  }
  const bytes = Buffer.from(payload.tarBase64, "base64");
  expect(bytes.byteLength).toBe(payload.tarBytes);
  expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(payload.sha256);
  const archivePath = path.join(tempRoot, "transfer.tar.gz");
  const destDir = path.join(tempRoot, "extracted");
  await fs.writeFile(archivePath, bytes, { mode: 0o600 });
  await fs.mkdir(destDir, { mode: 0o700 });
  await extractArchive({
    archivePath,
    destDir,
    kind: "tar",
    tarGzip: true,
    timeoutMs: 60_000,
    entryModes: "clamp",
    entryFilter: ({ kind }) => (kind === "file" || kind === "directory" ? "extract" : "skip"),
    onFiltered: "reject-archive",
  });
  return destDir;
}

async function sourceFixture(filename: string, contents: string) {
  const tmpRoot = await fs.realpath(tempDirs.make("file-transfer-identity-"));
  const source = path.join(tmpRoot, "source");
  const sourceFile = path.join(source, filename);
  await fs.mkdir(source);
  await fs.writeFile(sourceFile, contents);
  return { tmpRoot, source, sourceFile };
}

describe.runIf(process.platform !== "win32")("file-transfer real dir.fetch policy", () => {
  it("admits compressible directories within the compressed transfer budget", async () => {
    const contents = "a".repeat(2 * 1024 * 1024);
    const { tmpRoot, source } = await sourceFixture("repeated.txt", contents);
    const maxBytes = 64 * 1024;
    const { ctx } = createRealDirFetchContext({ approved: source, maxBytes });

    const result = await policy.handle(ctx);

    expect(result).toMatchObject({ ok: true });
    const payload = requireRecord(requireRecord(result, "result").payload, "payload");
    expect(payload).toMatchObject({ ok: true, path: source });
    expect(payload.tarBytes).toBeGreaterThan(0);
    expect(payload.tarBytes).toBeLessThanOrEqual(maxBytes);
    const destDir = await extractFetchedArchive(payload, tmpRoot);
    expect(await fs.readFile(path.join(destDir, "repeated.txt"), "utf8")).toBe(contents);
  });

  it("rejects a retargeted literal grant before archive preflight I/O", async () => {
    const tmpRoot = tempDirs.make("file-transfer-policy-");
    const approved = path.join(tmpRoot, "approved");
    const replacement = path.join(tmpRoot, "replacement");
    const requested = path.join(tmpRoot, "current");
    await fs.mkdir(approved);
    await fs.mkdir(replacement);
    await fs.writeFile(path.join(replacement, "secret.bin"), crypto.randomBytes(4096));
    await fs.symlink(replacement, requested);
    const { ctx, invokeNode } = createRealDirFetchContext({
      approved,
      maxBytes: 1,
      requested,
    });

    expect(await policy.handle(ctx)).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(requireInvokeParams(invokeNode, 0).expectedCanonicalPath).toBe(approved);
  });

  it.each([
    ["denies the real LF descendant in source preflight", "line\n.txt", true],
    ["preserves LF identity through producer, policy, and extraction", "line/n.txt", false],
  ] as const)("%s", async (_name, deniedName, denied) => {
    const filename = "line\n.txt";
    const { tmpRoot, source } = await sourceFixture(filename, "literal LF payload");
    const { ctx, invokeNode } = createRealDirFetchContext({
      approved: source,
      // A deny for the display alias must not deny the actual LF filename.
      denyPaths: [path.join(source, deniedName)],
    });
    const result = await policy.handle(ctx);
    if (denied) {
      expect(result).toMatchObject({
        ok: false,
        code: "PATH_POLICY_DENIED",
        details: { path: path.join(source, filename) },
      });
      expect(invokeNode).toHaveBeenCalledOnce();
      return;
    }
    expect(result, result.ok ? undefined : result.message).toMatchObject({ ok: true });
    const payload = requireRecord(requireRecord(result, "result").payload, "payload");
    expect(payload.entries).toContain(filename);
    expect(payload.entries).not.toContain("line/n.txt");
    const destDir = await extractFetchedArchive(payload, tmpRoot);
    expect(await fs.readFile(path.join(destDir, filename), "utf8")).toBe("literal LF payload");
    await expect(fs.stat(path.join(destDir, "line", "n.txt"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it.runIf(process.platform === "darwin")("authorizes real macOS metadata members", async () => {
    const contents = "synthetic file payload";
    const { tmpRoot, source, sourceFile } = await sourceFixture("note.txt", contents);
    const attr = ["-w", "user.openclaw-fixture", "synthetic metadata", sourceFile];
    execFileSync("/usr/bin/xattr", attr);
    const { ctx } = createRealDirFetchContext({ approved: source });
    const evaluated = vi.spyOn(filePolicy, "evaluateFilePolicyConstraints");
    const result = await policy.handle(ctx);
    expect(result).toMatchObject({ ok: true });
    const payload = requireRecord(requireRecord(result, "result").payload, "payload");
    const destDir = await extractFetchedArchive(payload, tmpRoot);
    const materialized = (await fs.readdir(destDir)).toSorted();
    expect(materialized).toContain("._note.txt");
    expect(await fs.readFile(path.join(destDir, "note.txt"), "utf8")).toBe(contents);
    const policyPaths = new Set(evaluated.mock.calls.map(([input]) => input.path));
    expect(policyPaths).toEqual(
      new Set([source, ...materialized.map((name) => path.join(source, name))]),
    );
    expect(payload.entries).toEqual(materialized);
  });
});
