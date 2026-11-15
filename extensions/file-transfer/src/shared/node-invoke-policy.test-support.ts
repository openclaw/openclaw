import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Header } from "tar";
import { expect, vi, type Mock } from "vitest";

type InvokeNode = OpenClawPluginNodeInvokePolicyContext["invokeNode"];
type Fields = Record<string, unknown>;
type ArchiveOptions = { producerRoot?: boolean };

export function tarEntries(entries: Record<string, string>, options?: ArchiveOptions): string {
  const blocks: Buffer[] = [];
  if (options?.producerRoot) {
    blocks.push(createTarFileHeader("./", 0, "Directory"));
  }
  for (const [relPath, contents] of Object.entries(entries)) {
    const payload = Buffer.from(contents);
    blocks.push(createTarFileHeader(relPath, payload.byteLength), payload);
    blocks.push(Buffer.alloc((512 - (payload.byteLength % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks)).toString("base64");
}

export function archiveMetadata(tarBase64: string): { tarBytes: number; sha256: string } {
  const buffer = Buffer.from(tarBase64, "base64");
  return {
    tarBytes: buffer.byteLength,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

function createTarFileHeader(path: string, size: number, type: "File" | "Directory" = "File") {
  const header = Buffer.alloc(512);
  new Header({ path, size, type }).encode(header);
  return header;
}

export function createCtx({
  command = "file.fetch",
  params: requestParams = { path: "/tmp/file.txt", maxBytes: 1024 },
  pluginConfig = {
    nodes: {
      "node-1": { allowReadPaths: ["/tmp/**"], allowWritePaths: ["/tmp/**"], maxBytes: 512 },
    },
  },
  approvals,
}: Partial<Pick<OpenClawPluginNodeInvokePolicyContext, "command" | "approvals">> & {
  params?: Fields;
  pluginConfig?: Fields;
}) {
  const invokeNode = vi.fn<InvokeNode>(async ({ params }: Parameters<InvokeNode>[0] = {}) => {
    const path = (params as { path?: unknown } | undefined)?.path;
    return nodeResult(typeof path === "string" ? path : "/tmp/file.txt", {
      size: 1,
      sha256: "a".repeat(64),
      binding: command === "file.write" ? WRITE_BINDING : EXISTING_BINDING,
    });
  });
  return {
    ctx: {
      nodeId: "node-1",
      command,
      params: requestParams,
      config: {},
      pluginConfig: { policyVersion: 2, ...pluginConfig },
      node: { nodeId: "node-1", displayName: "Node One" },
      ...(approvals ? { approvals } : {}),
      invokeNode,
    },
    invokeNode,
  };
}

export const requireRecord = createRequireRecord("object", "label-not-object");
export const EXISTING_BINDING = { kind: "existing", device: "1", inode: "2" } as const;
export const WRITE_BINDING = {
  kind: "write",
  anchorPath: "/tmp",
  anchorDevice: "1",
  anchorInode: "2",
} as const;

function nodeResult(path: string, fields: Fields) {
  return { ok: true as const, payload: { ok: true, binding: EXISTING_BINDING, path, ...fields } };
}

export function mockDirFetchArchive(
  invokeNode: Mock<InvokeNode>,
  root: string,
  entries: Record<string, string>,
  options?: ArchiveOptions,
) {
  const tarBase64 = tarEntries(entries, options);
  for (const payload of [
    { entries: ["ok.txt"], fileCount: 1, preflightOnly: true },
    { tarBase64, ...archiveMetadata(tarBase64), fileCount: Object.keys(entries).length },
  ]) {
    invokeNode.mockResolvedValueOnce(nodeResult(root, payload));
  }
}

export function expectRecordFields(record: Fields, fields: Fields) {
  expect(record).toEqual(expect.objectContaining(fields));
}

export function expectResultFields(result: unknown, fields: Fields) {
  expectRecordFields(requireRecord(result, "policy result"), fields);
}

export function requireInvokeParams(invokeNode: Mock<InvokeNode>, callIndex: number) {
  const call = invokeNode.mock.calls[callIndex]?.[0];
  const request = requireRecord(call, `invoke call ${callIndex + 1}`);
  return requireRecord(request.params, `invoke call ${callIndex + 1} params`);
}
