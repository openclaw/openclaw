import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
import { persistLiteralGrant } from "./policy.js";

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

afterEach(() => {
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
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({ pluginConfig: {} });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "NO_POLICY" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("uses exact allow-once plugin approval once across preflight and final invoke", async () => {
    const decision = "allow-once" as const;
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async (_request: unknown) => ({ id: "approval-1", decision })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: {
        nodes: {
          "node-1": {
            ask: "on-miss",
            allowReadPaths: ["/allowed/**"],
            maxBytes: 256,
            followSymlinks: true,
          },
        },
      },
      approvals,
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(invokeNode).toHaveBeenCalledTimes(2);
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
    expect(invokeNode).toHaveBeenNthCalledWith(1, {
      params: {
        path: "/tmp/new.txt",
        followSymlinks: true,
        maxBytes: 256,
        preflightOnly: true,
      },
    });
    expect(invokeNode).toHaveBeenNthCalledWith(2, {
      params: {
        path: "/tmp/new.txt",
        followSymlinks: true,
        maxBytes: 256,
        expectedCanonicalPath: "/tmp/new.txt",
        expectedBinding: EXISTING_BINDING,
      },
    });

    expect(persistLiteralGrant).not.toHaveBeenCalled();
  });

  it("returns an actionable warning when the operation succeeds but persistence fails", async () => {
    vi.mocked(persistLiteralGrant).mockRejectedValueOnce(new Error("config changed"));
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision: "allow-always" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: { nodes: { "node-1": { ask: "on-miss" } } },
      approvals,
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(requireRecord(requireRecord(result, "result").payload, "payload")).toHaveProperty(
      "standingApprovalWarning",
    );
  });

  it("reuses an exact literal grant and reapproves canonical drift", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-2", decision: "allow-always" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/report-*.txt" },
      pluginConfig: {
        policyVersion: 2,
        nodes: { "node-1": { ask: "on-miss" } },
        literalGrants: [
          {
            nodeId: "node-1",
            command: "file.fetch",
            requestedPath: "/tmp/report-*.txt",
            canonicalPath: "/tmp/report-*.txt",
          },
        ],
      },
      approvals,
    });

    expect((await policy.handle(ctx)).ok).toBe(true);
    expect(approvals.request).not.toHaveBeenCalled();

    invokeNode.mockReset();
    invokeNode.mockResolvedValue({
      ok: true,
      payload: { ok: true, binding: EXISTING_BINDING, path: "/tmp/other.txt" },
    });
    expect((await policy.handle(ctx)).ok).toBe(true);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(persistLiteralGrant).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "file.fetch",
      requestedPath: "/tmp/report-*.txt",
      canonicalPath: "/tmp/other.txt",
      pendingReapprovalSelector: undefined,
    });
  });

  it.each([
    {
      label: "explicit deny",
      decision: "deny",
      code: "APPROVAL_DENIED",
      message: "file.fetch APPROVAL_DENIED: operator denied the prompt",
    },
    {
      label: "undefined decision",
      decision: undefined,
      code: "APPROVAL_UNAVAILABLE",
      message:
        "file.fetch APPROVAL_UNAVAILABLE: no operator client connected to approve the request",
    },
    {
      label: "arbitrary truthy string",
      decision: "accept",
      code: "APPROVAL_DENIED",
      message: "file.fetch APPROVAL_DENIED: invalid approval decision",
    },
  ])("fails closed for $label", async ({ decision, code, message }) => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision })),
    } as unknown as NonNullable<OpenClawPluginNodeInvokePolicyContext["approvals"]>;
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: {
        nodes: {
          "node-1": {
            ask: "on-miss",
            allowReadPaths: ["/allowed/**"],
          },
        },
      },
      approvals,
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code, message });
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("marks node transport failures as unavailable", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/file.txt" },
    });
    invokeNode.mockResolvedValueOnce({
      ok: false,
      code: "TIMEOUT",
      message: "node timed out",
      details: { nodeError: { code: "TIMEOUT" } },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, {
      ok: false,
      code: "TIMEOUT",
      unavailable: true,
      details: { nodeError: { code: "TIMEOUT" } },
    });
  });

  it("refuses restricted writes before mutation when an old node ignores hardlink rejection", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "file.write",
      params: {
        path: "/tmp/AGENTS.md",
        contentBase64: Buffer.from("payload").toString("base64"),
        overwrite: true,
        rejectHardlinks: true,
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "HARDLINK_REJECTION_UNSUPPORTED" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      preflightOnly: true,
      rejectHardlinks: true,
    });
  });
  it("checks file.write canonical policy before the mutating node call", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "file.write",
      params: {
        path: "/tmp/link/out.txt",
        contentBase64: Buffer.from("payload").toString("base64"),
        createParents: true,
      },
      pluginConfig: {
        nodes: {
          "node-1": {
            allowWritePaths: ["/tmp/**"],
            followSymlinks: true,
          },
        },
      },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        binding: WRITE_BINDING,
        path: "/etc/out.txt",
        size: 7,
        sha256: "b".repeat(64),
        overwritten: false,
      },
    });

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "SYMLINK_TARGET_DENIED" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      path: "/tmp/link/out.txt",
      followSymlinks: true,
      preflightOnly: true,
    });
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
    ...(nodePolicy ? { pluginConfig: { nodes: { "node-1": nodePolicy } } } : {}),
    ...overrides,
  });
}

function nodePayload(root: string, fields: Record<string, unknown>) {
  return {
    ok: true as const,
    payload: { ok: true, binding: EXISTING_BINDING, path: root, ...fields },
  };
}

describe("file-transfer dir.fetch archive policy", () => {
  it("rejects dir.fetch preflight responses without an entry list", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = directoryContext("/home/me", {
      allowReadPaths: ["/home/me", "/home/me/**"],
    });
    invokeNode.mockResolvedValueOnce(
      nodePayload("/home/me", { fileCount: 2, preflightOnly: true }),
    );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PREFLIGHT_ENTRIES_MISSING" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid dir.fetch preflight entries before requesting the archive", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = directoryContext("/home/me", {
      allowReadPaths: ["/home/me", "/home/me/**"],
    });
    invokeNode.mockResolvedValueOnce(
      nodePayload("/home/me", {
        entries: ["ok.txt", "/etc/passwd"],
        fileCount: 2,
        preflightOnly: true,
      }),
    );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PREFLIGHT_ENTRY_INVALID" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized dir.fetch preflight entry lists before requesting the archive", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const entries = Array.from({ length: 5001 }, (_, index) => `file-${index}.txt`);
    const { ctx, invokeNode } = directoryContext("/home/me", {
      allowReadPaths: ["/home/me", "/home/me/**"],
    });
    invokeNode.mockResolvedValueOnce(
      nodePayload("/home/me", { entries, fileCount: entries.length, preflightOnly: true }),
    );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PREFLIGHT_ENTRIES_TOO_MANY" });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });

  testUnlessWindows("rejects mismatched dir.fetch archive integrity metadata", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const tarBase64 = tarEntries({ "a.txt": "a" });
    const { ctx, invokeNode } = directoryContext("/tmp/project");
    invokeNode
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", { entries: ["a.txt"], fileCount: 1, preflightOnly: true }),
      )
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", {
          tarBase64,
          tarBytes: 1,
          sha256: "c".repeat(64),
          fileCount: 1,
        }),
      );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "ARCHIVE_SIZE_MISMATCH" });
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "dir.fetch",
        decision: "error",
        errorCode: "ARCHIVE_SIZE_MISMATCH",
      }),
    );
  });

  it.each([{ root: "C:\\transfer", deniedPath: "C:\\transfer\\private" }])(
    "rejects final dir.fetch archives with a denied implicit parent directory ($root)",
    async ({ root, deniedPath }) => {
      const policy = createFileTransferNodeInvokePolicy();
      const approvals = {
        request: vi.fn(async () => ({ id: "approval-1", decision: "allow-always" as const })),
      };
      const { ctx, invokeNode } = directoryContext(
        root,
        { ask: "always", denyPaths: [deniedPath] },
        { approvals },
      );
      // The untrusted final response has no directory headers; preflight remains enabled.
      mockDirFetchArchive(invokeNode, root, { "private/nested/value.txt": "value" });
      vi.mocked(appendFileTransferAudit).mockClear();

      const result = await policy.handle(ctx);

      expect(invokeNode).toHaveBeenCalledTimes(2);
      expect(requireInvokeParams(invokeNode, 0).preflightOnly).toBe(true);
      expect(approvals.request).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        ok: false,
        code: "PATH_POLICY_DENIED",
        details: { path: deniedPath },
      });
      expect(appendFileTransferAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ decision: "allowed" }),
      );
      expect(persistLiteralGrant).not.toHaveBeenCalled();
    },
  );

  it("accepts the producer root header at the exact descendant cap", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`file-${index}.txt`, ""]),
    );
    const { ctx, invokeNode } = directoryContext("/home/me", {
      allowReadPaths: ["/home/me", "/home/me/**"],
    });
    // The real producer archives "."; its root directory header is one member.
    mockDirFetchArchive(invokeNode, "/home/me", entries, { producerRoot: true });

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    {
      name: "counts implicit parents toward the descendant cap",
      leaves: 2501,
      sharedParents: false,
      allowed: false,
    },
    {
      name: "counts shared parents once at the descendant cap",
      leaves: 4998,
      sharedParents: true,
      allowed: true,
    },
  ])("$name", async ({ leaves, sharedParents, allowed }) => {
    const entries = Object.fromEntries(
      Array.from({ length: leaves }, (_, index) => [
        sharedParents ? `parent/nested/file-${index}` : `dir-${index}/file`,
        "",
      ]),
    );
    const { ctx, invokeNode } = directoryContext("/home/me", {
      allowReadPaths: ["/home/me", "/home/me/**"],
    });
    mockDirFetchArchive(invokeNode, "/home/me", entries);

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    expect(invokeNode).toHaveBeenCalledTimes(2);
    if (allowed) {
      expect(result).toMatchObject({ ok: true });
    } else {
      expect(result).toMatchObject({ ok: false, code: "ARCHIVE_ENTRIES_TOO_MANY" });
    }
  });

  testUnlessWindows("rejects oversized final dir.fetch archive entry lists", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const tarBase64 = tarEntries(
      Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`file-${index}.txt`, "x"])),
    );
    const { ctx, invokeNode } = directoryContext("/tmp/project", {
      allowReadPaths: ["/tmp/project", "/tmp/project/**"],
    });
    invokeNode
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", { entries: ["file-0.txt"], fileCount: 1, preflightOnly: true }),
      )
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", { tarBase64, ...archiveMetadata(tarBase64), fileCount: 5001 }),
      );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "ARCHIVE_ENTRIES_TOO_MANY" });
    expect(invokeNode).toHaveBeenCalledTimes(2);
  });

  it("rejects final dir.fetch archive responses without readable archive entries", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = directoryContext("/tmp/project");
    invokeNode
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", { entries: ["a.txt"], fileCount: 1, preflightOnly: true }),
      )
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", { tarBytes: 7, sha256: "c".repeat(64), fileCount: 1 }),
      );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "ARCHIVE_ENTRIES_MISSING" });
    expect(invokeNode).toHaveBeenCalledTimes(2);
  });
});
