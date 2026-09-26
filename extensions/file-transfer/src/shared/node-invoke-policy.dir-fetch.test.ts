// File Transfer tests cover node invoke policy plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { appendFileTransferAudit } from "./audit.js";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";
import {
  EXISTING_BINDING,
  archiveMetadata,
  createCtx,
  expectRecordFields,
  expectResultFields,
  mockDirFetchArchive,
  requireInvokeParams,
  requireRecord,
  tarEntries,
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

const testUnlessWindows = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  vi.mocked(persistLiteralGrant).mockReset();
  vi.mocked(persistLiteralGrant).mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("./audit.js");
  vi.doUnmock("./policy.js");
  vi.resetModules();
});

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
  it("checks every dir.fetch preflight entry before requesting the archive", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = directoryContext("/home/me", {
      allowReadPaths: ["/home/me", "/home/me/**"],
      denyPaths: ["**/.ssh/**"],
    });
    invokeNode.mockResolvedValueOnce(
      nodePayload("/home/me", {
        entries: ["ok.txt", ".ssh/id_rsa"],
        fileCount: 2,
        preflightOnly: true,
      }),
    );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: false, code: "PATH_POLICY_DENIED" });
    expect(
      requireRecord(requireRecord(result, "policy result").details, "result details").path,
    ).toBe("/home/me/.ssh");
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expectRecordFields(requireInvokeParams(invokeNode, 0), {
      path: "/home/me",
      preflightOnly: true,
    });
  });

  it("allow-always approval covers one validated dir.fetch tree while deny rules still apply", async () => {
    const decision = "allow-always" as const;
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async (_request: unknown) => ({ id: "approval-1", decision })),
    };
    const tarBase64 = tarEntries({ "a.txt": "a", "sub/b.txt": "b" });
    const { ctx, invokeNode } = directoryContext(
      "/home/project",
      {
        ask: "on-miss",
        denyPaths: ["**/.ssh/**"],
      },
      { approvals },
    );
    invokeNode
      .mockResolvedValueOnce(
        nodePayload("/home/project", { entries: ["a.txt", "sub/b.txt"], preflightOnly: true }),
      )
      .mockResolvedValueOnce(
        nodePayload("/home/project", { tarBase64, ...archiveMetadata(tarBase64) }),
      );

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    const request = requireRecord(approvals.request.mock.calls[0]?.[0], "approval request");
    expect(request.description).toContain("This fetch includes descendants");
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(persistLiteralGrant).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "dir.fetch",
      requestedPath: "/home/project",
      canonicalPath: "/home/project",
      pendingReapprovalSelector: undefined,
    });
  });

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

  testUnlessWindows(
    "continues dir.fetch after preflight without forwarding caller preflightOnly",
    async () => {
      const policy = createFileTransferNodeInvokePolicy();
      const tarBase64 = tarEntries({
        "a.txt": "a",
        "sub/b.txt": "b",
      });
      const { ctx, invokeNode } = directoryContext("/tmp/project", undefined, {
        params: { path: "/tmp/project", preflightOnly: true },
      });
      invokeNode
        .mockResolvedValueOnce(
          nodePayload("/tmp/project", {
            entries: ["a.txt", "sub/b.txt"],
            fileCount: 2,
            preflightOnly: true,
          }),
        )
        .mockResolvedValueOnce(
          nodePayload("/tmp/project", {
            tarBase64,
            ...archiveMetadata(tarBase64),
            fileCount: 2,
            entries: ["a.txt", "sub/b.txt"],
          }),
        );

      const result = await policy.handle(ctx);

      expectResultFields(result, { ok: true });
      expect(invokeNode).toHaveBeenCalledTimes(2);
      expectRecordFields(requireInvokeParams(invokeNode, 0), {
        path: "/tmp/project",
        preflightOnly: true,
      });
      expect(requireInvokeParams(invokeNode, 1).preflightOnly).toBeUndefined();
      expect(requireInvokeParams(invokeNode, 1).expectedCanonicalPath).toBe("/tmp/project");
    },
  );

  testUnlessWindows("audits dir.fetch archive bytes after a successful transfer", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const tarBase64 = tarEntries({
      "a.txt": "a",
    });
    const { tarBytes, sha256 } = archiveMetadata(tarBase64);
    const { ctx } = directoryContext("/tmp/project");
    const invokeNode = vi.mocked(ctx.invokeNode);
    invokeNode
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", { entries: ["a.txt"], fileCount: 1, preflightOnly: true }),
      )
      .mockResolvedValueOnce(
        nodePayload("/tmp/project", { tarBase64, tarBytes, sha256, fileCount: 1 }),
      );

    const result = await policy.handle(ctx);

    expectResultFields(result, { ok: true });
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "dir.fetch",
        requestedPath: "/tmp/project",
        canonicalPath: "/tmp/project",
        decision: "allowed",
        sizeBytes: tarBytes,
        sha256,
      }),
    );
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

  testUnlessWindows(
    "checks final dir.fetch archive entries before returning the archive",
    async () => {
      const policy = createFileTransferNodeInvokePolicy();
      const tarBase64 = tarEntries({
        "ok.txt": "ok",
        ".ssh/id_rsa": "secret",
      });
      const { ctx, invokeNode } = directoryContext("/home/me", {
        allowReadPaths: ["/home/me", "/home/me/**"],
        denyPaths: ["**/.ssh/**"],
      });
      invokeNode
        .mockResolvedValueOnce(
          nodePayload("/home/me", { entries: ["ok.txt"], fileCount: 1, preflightOnly: true }),
        )
        .mockResolvedValueOnce(
          nodePayload("/home/me", { tarBase64, ...archiveMetadata(tarBase64), fileCount: 2 }),
        );

      const result = await policy.handle(ctx);

      expectResultFields(result, { ok: false, code: "PATH_POLICY_DENIED" });
      expect(
        requireRecord(requireRecord(result, "policy result").details, "result details").path,
      ).toBe("/home/me/.ssh");
      expect(invokeNode).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { root: "/home/me", deniedPath: "/home/me/private" },
    { root: "C:\\transfer", deniedPath: "C:\\transfer\\private" },
  ])(
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
