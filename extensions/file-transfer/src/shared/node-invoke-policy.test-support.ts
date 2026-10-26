import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";

type InvokeNode = OpenClawPluginNodeInvokePolicyContext["invokeNode"];
type Fields = Record<string, unknown>;

export function tarEntries(
  entries: Record<string, string>,
  options?: { producerRoot?: boolean },
): string {
  const blocks: Buffer[] = [];
  if (options?.producerRoot) {
    blocks.push(createTarFileHeader("./", 0, "5"));
  }
  for (const [relPath, contents] of Object.entries(entries)) {
    const payload = Buffer.from(contents);
    blocks.push(createTarFileHeader(relPath, payload.byteLength), payload);
    const padding = (512 - (payload.byteLength % 512)) % 512;
    blocks.push(Buffer.alloc(padding));
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

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(`${text}\0`.slice(-length), offset, length, "ascii");
}

function createTarFileHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, "utf8");
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(" ", 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
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
}: {
  command?: string;
  params?: Fields;
  pluginConfig?: Fields;
  approvals?: OpenClawPluginNodeInvokePolicyContext["approvals"];
}) {
  const invokeNode = vi.fn<InvokeNode>(async ({ params }: Parameters<InvokeNode>[0] = {}) => ({
    ok: true,
    payload: {
      ok: true,
      path:
        typeof (params as { path?: unknown } | undefined)?.path === "string"
          ? (params as { path: string }).path
          : "/tmp/file.txt",
      size: 1,
      sha256: "a".repeat(64),
      binding: command === "file.write" ? WRITE_BINDING : EXISTING_BINDING,
    },
  }));
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

export function mockDirFetchArchive(
  invokeNode: ReturnType<typeof createCtx>["invokeNode"],
  root: string,
  entries: Record<string, string>,
  options?: { producerRoot?: boolean },
) {
  const tarBase64 = tarEntries(entries, options);
  for (const payload of [
    { entries: ["ok.txt"], fileCount: 1, preflightOnly: true },
    { tarBase64, ...archiveMetadata(tarBase64), fileCount: Object.keys(entries).length },
  ]) {
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: { ok: true, binding: EXISTING_BINDING, path: root, ...payload },
    });
  }
}

export function expectRecordFields(record: Fields, fields: Fields) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function expectResultFields(result: unknown, fields: Fields) {
  expectRecordFields(requireRecord(result, "policy result"), fields);
}

export function requireInvokeParams(
  invokeNode: ReturnType<typeof vi.fn<InvokeNode>>,
  callIndex: number,
) {
  const call = (invokeNode.mock.calls as unknown[][])[callIndex]?.[0];
  const request = requireRecord(call, `invoke call ${callIndex + 1}`);
  return requireRecord(request.params, `invoke call ${callIndex + 1} params`);
}
