import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { humanSize } from "../shared/params.js";
import { FILE_TRANSFER_SUBDIR, FILE_WRITE_HARD_MAX_BYTES } from "./descriptors.js";
import { createFileWriteTool } from "./file-write-tool.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  listNodes: vi.fn(),
  resolveNodeIdFromList: vi.fn(),
}));

// mock-isolation: File-write fixtures must not read the operator's media store.
vi.mock("openclaw/plugin-sdk/media-store", () => ({ readMediaBuffer: vi.fn() }));
// mock-isolation: Record audit calls without opening the durable audit database.
vi.mock("../shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

function execute(input: { contentBase64?: string; sourceMediaId?: string }) {
  return createFileWriteTool().execute("tool-call-1", {
    node: "node-1",
    path: "/tmp/out.bin",
    ...input,
  });
}

function prepareWrite(size: number, sha256 = "a".repeat(64)) {
  vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1", displayName: "Node 1" }]);
  vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
  vi.mocked(callGatewayTool).mockResolvedValue({
    payload: { ok: true, path: "/tmp/out.bin", size, sha256, overwritten: false },
  });
}

describe("file_write tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["inline", "AAA@@@"],
    ["whitespace-heavy", " ".repeat(1024 * 1024)],
  ])(
    "rejects malformed %s base64 without decoding or dispatching",
    async (_name, contentBase64) => {
      const bufferFrom = vi.spyOn(Buffer, "from");
      await expect(execute({ contentBase64 })).rejects.toThrow("contentBase64 is not valid base64");
      expect(bufferFrom).not.toHaveBeenCalled();
      expect(callGatewayTool).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized inline base64 before invoking the node", async () => {
    const encodedLength = Math.ceil(((FILE_WRITE_HARD_MAX_BYTES + 1) * 4) / 3);
    await expect(execute({ contentBase64: "A".repeat(encodedLength) })).rejects.toThrow(
      `decoded content is ${FILE_WRITE_HARD_MAX_BYTES + 1} bytes; maximum is ${FILE_WRITE_HARD_MAX_BYTES} bytes (${humanSize(FILE_WRITE_HARD_MAX_BYTES)})`,
    );

    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("accepts exactly 16 MiB of inline data", async () => {
    prepareWrite(FILE_WRITE_HARD_MAX_BYTES);
    const contentBase64 = Buffer.alloc(FILE_WRITE_HARD_MAX_BYTES).toString("base64");

    await expect(execute({ contentBase64 })).resolves.toMatchObject({
      details: { size: FILE_WRITE_HARD_MAX_BYTES },
    });

    expect(callGatewayTool).toHaveBeenCalledOnce();
  });

  it("reads file_fetch media from the shared managed tool namespace", async () => {
    const buffer = Buffer.from("copied");
    vi.mocked(readMediaBuffer).mockResolvedValue({
      id: "media-1",
      buffer,
      path: "/gateway/media/tool-file-transfer/media-1.bin",
      size: buffer.byteLength,
    });
    prepareWrite(buffer.byteLength, crypto.createHash("sha256").update(buffer).digest("hex"));
    const result = await execute({ sourceMediaId: "media-1" });

    expect(readMediaBuffer).toHaveBeenCalledWith(
      "media-1",
      FILE_TRANSFER_SUBDIR,
      FILE_WRITE_HARD_MAX_BYTES,
    );
    expect(result.details).toMatchObject({ source: "media", size: buffer.byteLength });
  });
});
