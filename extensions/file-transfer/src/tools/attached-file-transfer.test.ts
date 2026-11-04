import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  call: vi.fn<
    (
      method: string,
      options: unknown,
      params: Record<string, unknown>,
      extra?: Parameters<
        (typeof import("openclaw/plugin-sdk/agent-harness-runtime"))["callGatewayTool"]
      >[3],
    ) => Promise<unknown>
  >(),
  list: vi.fn(),
  saved: "",
  active: true,
  sourceActive: true,
  revokeOnSave: false,
  audit: vi.fn(async () => {}),
  readSourceMedia: vi.fn<(id: string) => Promise<{ buffer: Buffer }>>(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: state.call,
  listNodes: state.list,
  resolveNodeIdFromList: vi.fn(),
  readGatewayToolOperatorScopes: () => ["operator.sessions.write"],
  withGatewayToolAttachmentRead: async (
    paths: readonly string[],
    consume: (assert: () => void) => Promise<unknown>,
  ) => {
    if (!paths.every((file) => file.endsWith("own-source.bin"))) {
      throw new Error("foreign source media");
    }
    return await consume(() => {
      if (!state.sourceActive || !state.active) {
        throw new Error("source revoked");
      }
    });
  },
}));
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  NODE_COMPUTER_RESOURCE_FETCH_COMMAND: "computer.resource.fetch",
}));
vi.mock("../shared/audit-context.js", () => ({ bindFileTransferAudit: () => state.audit }));
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  readMediaBuffer: state.readSourceMedia,
  saveMediaBuffer: async (buffer: Buffer) => {
    await writeFile(state.saved, buffer);
    if (state.revokeOnSave) {
      state.active = false;
    }
    return { id: "owned-media", path: state.saved };
  },
}));
import { createFileFetchTool } from "./file-fetch-tool.js";
import { createFileWriteTool } from "./file-write-tool.js";

const frame = { environmentId: "env-owned", ownerEpoch: 7, generation: 2 };
const bytes = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.alloc(16),
  Buffer.from([3, 0, 0, 255, 128]),
]);
beforeEach(async () => {
  state.call.mockReset();
  state.list.mockReset();
  state.active = true;
  state.sourceActive = true;
  state.revokeOnSave = false;
  const dir = path.join(process.cwd(), ".openclaw/tmp/guest-relay-proof/attached-file-fixture");
  await mkdir(dir, { recursive: true });
  state.saved = path.join(dir, "result.zip");
  state.call.mockImplementation(
    async (method: string, _options: unknown, params: Record<string, unknown>) => {
      if (!state.active) {
        throw new Error("guest revoked");
      }
      if (params.environmentId !== frame.environmentId) {
        throw new Error("foreign conversation environment");
      }
      if (method === "environments.session.status") {
        return {
          attachment: frame,
          connection: { nodeId: "private-node", connectionId: "owned-connection" },
        };
      }
      if (method !== "environments.session.invoke") {
        throw new Error("unexpected route");
      }
      return {
        ok: true,
        nodeId: "private-node",
        connection: { nodeId: "private-node", connectionId: "owned-connection" },
        attachment: frame,
        payload: {
          ok: true,
          path: "/workspace/result.zip",
          size: bytes.length,
          mimeType: "application/zip",
          base64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      };
    },
  );
});
afterEach(async () => {
  if (state.saved) {
    await rm(path.dirname(state.saved), { recursive: true, force: true });
  }
});
it("exports the original ZIP bytes through the owned RPC and existing binary media store", async () => {
  const result = await createFileFetchTool().execute("fetch", {
    environmentId: frame.environmentId,
    path: "/workspace/result.zip",
  });
  expect(await readFile(state.saved)).toEqual(bytes);
  expect(result.details).toMatchObject({ localPath: state.saved, size: bytes.length });
  expect(state.list).not.toHaveBeenCalled();
  expect(state.call.mock.calls[0]?.[0]).toBe("environments.session.invoke");
  expect(state.call.mock.calls[0]?.[2]).not.toHaveProperty("nodeId");
});
it("does not publish a staged artifact after revocation", async () => {
  state.revokeOnSave = true;
  await expect(
    createFileFetchTool().execute("fetch", {
      environmentId: frame.environmentId,
      path: "/workspace/result.zip",
    }),
  ).rejects.toThrow("revoked");
});
it("rejects foreign environments without falling back to paired nodes", async () => {
  await expect(
    createFileFetchTool().execute("fetch", {
      environmentId: "env-foreign",
      path: "/workspace/result.zip",
    }),
  ).rejects.toThrow("foreign");
  expect(state.list).not.toHaveBeenCalled();
});
it("rejects target and Gateway credential substitution", async () => {
  await expect(
    createFileFetchTool().execute("fetch", {
      environmentId: frame.environmentId,
      node: "other",
      path: "/workspace/result.zip",
    }),
  ).rejects.toThrow("not both");
  await expect(
    createFileFetchTool().execute("fetch", {
      environmentId: frame.environmentId,
      gatewayToken: "synthetic-token",
      path: "/workspace/result.zip",
    }),
  ).rejects.toThrow("current conversation");
  expect(state.call).not.toHaveBeenCalled();
});

it("removes denied export staging", async () => {
  state.revokeOnSave = true;
  await expect(
    createFileFetchTool().execute("fetch", {
      environmentId: frame.environmentId,
      path: "/workspace/result.zip",
    }),
  ).rejects.toThrow("revoked");
  await expect(readFile(state.saved)).rejects.toHaveProperty("code", "ENOENT");
});

it("exports recording-resource MP4 bytes through the binary file tool", async () => {
  const original = state.call.getMockImplementation();
  if (!original) {
    throw new Error("missing Gateway fixture");
  }
  const mp4 = Buffer.from([
    0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115,
    111, 50, 0, 255, 128, 254,
  ]);
  state.call.mockImplementation(async (method, options, params) =>
    method === "environments.session.invoke"
      ? {
          ok: true,
          nodeId: "private-node",
          connection: { nodeId: "private-node", connectionId: "owned-connection" },
          attachment: frame,
          payload: {
            ok: true,
            path: "resource:owned/video.mp4",
            size: mp4.length,
            mimeType: "video/mp4",
            sha256: createHash("sha256").update(mp4).digest("hex"),
            base64: mp4.toString("base64"),
          },
        }
      : original(method, options, params),
  );
  await createFileFetchTool().execute("recording", {
    environmentId: frame.environmentId,
    resourceHandle: "openclaw:computer-resource:v1:owned",
  });
  expect(await readFile(state.saved)).toEqual(mp4);
  expect(state.call.mock.calls[0]?.[2]).toMatchObject({
    command: "computer.resource.fetch",
    params: { resourceHandle: "openclaw:computer-resource:v1:owned" },
  });
});
it("rejects a changed node connection before export publication", async () => {
  const original = state.call.getMockImplementation();
  if (!original) {
    throw new Error("missing Gateway fixture");
  }
  state.call.mockImplementation(async (method, options, params) =>
    method === "environments.session.status"
      ? {
          attachment: frame,
          connection: { nodeId: "private-node", connectionId: "replaced-connection" },
        }
      : original(method, options, params),
  );
  await expect(
    createFileFetchTool().execute("fetch", {
      environmentId: frame.environmentId,
      path: "/workspace/result.zip",
    }),
  ).rejects.toThrow("owner changed");
});

it("cleans staged recording bytes if the node connection changes during save", async () => {
  const original = state.call.getMockImplementation();
  if (!original) {
    throw new Error("missing Gateway fixture");
  }
  state.call.mockImplementation(async (method, options, params) => {
    if (method === "environments.session.status") {
      let saved = false;
      try {
        await readFile(state.saved);
        saved = true;
      } catch {}
      return {
        attachment: frame,
        connection: {
          nodeId: "private-node",
          connectionId: saved ? "new-connection" : "owned-connection",
        },
      };
    }
    return original(method, options, params);
  });
  await expect(
    createFileFetchTool().execute("fetch", {
      environmentId: frame.environmentId,
      path: "/workspace/result.zip",
    }),
  ).rejects.toThrow("owner changed");
  await expect(readFile(state.saved)).rejects.toHaveProperty("code", "ENOENT");
});

it("denies foreign media-backed guest file writes before source read or dispatch", async () => {
  state.readSourceMedia.mockClear();
  await expect(
    createFileWriteTool().execute("write", {
      environmentId: frame.environmentId,
      path: "/workspace/in.bin",
      sourceMediaId: "foreign-source.bin",
    }),
  ).rejects.toThrow("foreign source media");
  expect(state.readSourceMedia).not.toHaveBeenCalled();
  expect(state.call).not.toHaveBeenCalled();
});
it("writes authorized source-media bytes through the same scoped file route", async () => {
  state.readSourceMedia.mockResolvedValue({ buffer: Buffer.from([0, 255, 128]) });
  state.call.mockImplementation(async (method) =>
    method === "environments.session.status"
      ? {
          attachment: frame,
          connection: { nodeId: "private-node", connectionId: "owned-connection" },
        }
      : {
          ok: true,
          nodeId: "private-node",
          attachment: frame,
          connection: { nodeId: "private-node", connectionId: "owned-connection" },
          payload: {
            ok: true,
            path: "/workspace/in.bin",
            size: 3,
            sha256: "synthetic",
            overwritten: false,
          },
        },
  );
  await createFileWriteTool().execute("write", {
    environmentId: frame.environmentId,
    path: "/workspace/in.bin",
    sourceMediaId: "own-source.bin",
  });
  expect(state.readSourceMedia).toHaveBeenCalled();
  expect(state.call.mock.calls[0]?.[2]).toMatchObject({
    command: "file.write",
    params: { contentBase64: Buffer.from([0, 255, 128]).toString("base64") },
  });
});

it("does not dispatch media bytes when only the held source scope revokes during the read", async () => {
  const buffer = Buffer.from([1, 255, 128]);
  state.readSourceMedia.mockImplementation(async () => {
    state.sourceActive = false;
    return { buffer };
  });
  await expect(
    createFileWriteTool().execute("write", {
      environmentId: frame.environmentId,
      path: "/workspace/in.bin",
      sourceMediaId: "own-source.bin",
    }),
  ).rejects.toThrow("source revoked");
  expect(state.active).toBe(true);
  expect(state.call).not.toHaveBeenCalled();
  expect(buffer).toEqual(Buffer.alloc(3));
});
it("carries source authority through deferred Gateway preparation to the real send precondition", async () => {
  let prepared = () => {};
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = vi.fn();
  const buffer = Buffer.from([1, 255, 128]);
  state.readSourceMedia.mockResolvedValue({ buffer });
  state.call.mockImplementation(async (_method, _options, _params, extra) => {
    prepared();
    await gate;
    if (!extra?.dispatchAuthority) {
      throw new Error("missing trusted source precondition");
    }
    extra.dispatchAuthority.assertCurrent();
    sent();
    throw new Error("unexpected destination invocation");
  });
  const pending = createFileWriteTool().execute("write", {
    environmentId: frame.environmentId,
    path: "/workspace/in.bin",
    sourceMediaId: "own-source.bin",
  });
  await ready;
  state.sourceActive = false;
  release();
  await expect(pending).rejects.toThrow("source revoked");
  expect(state.active).toBe(true);
  expect(sent).not.toHaveBeenCalled();
  expect(buffer).toEqual(Buffer.alloc(3));
});
