import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const upsertSessionEntryMock = vi.fn();

let configOverride: Record<string, unknown> = {
  ...createSubagentSpawnTestConfig(),
};
let workspaceDirOverride = "";
let sessionStore: Record<string, Record<string, unknown>> = {};
let subagentSpawnModule: Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;

beforeAll(async () => {
  subagentSpawnModule = await loadSubagentSpawnModuleForTest({
    callGatewayMock,
    getRuntimeConfig: () => configOverride,
    upsertSessionEntryMock,
    workspaceDir: workspaceDirOverride || os.tmpdir(),
    getSessionStore: () => sessionStore,
  });
});

// --- decodeStrictBase64 ---

describe("decodeStrictBase64", () => {
  const maxBytes = 1024;

  it("valid base64 returns buffer with correct bytes", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    const input = "hello world";
    const encoded = Buffer.from(input).toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result?.toString("utf8")).toBe(input);
  });

  it("empty string returns null", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("", maxBytes)).toBeNull();
  });

  it("bad padding (length % 4 !== 0) returns null", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("abc", maxBytes)).toBeNull();
  });

  it("non-base64 chars returns null", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("!@#$", maxBytes)).toBeNull();
  });

  it("whitespace-only returns null (empty after strip)", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    expect(decodeStrictBase64("   ", maxBytes)).toBeNull();
  });

  it("pre-decode oversize guard: encoded string > maxEncodedBytes * 2 returns null", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    // maxEncodedBytes = ceil(1024/3)*4 = 1368; *2 = 2736
    const oversized = "A".repeat(2737);
    expect(decodeStrictBase64(oversized, maxBytes)).toBeNull();
  });

  it("decoded byteLength exceeds maxDecodedBytes returns null", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    const bigBuf = Buffer.alloc(1025, 0x42);
    const encoded = bigBuf.toString("base64");
    expect(decodeStrictBase64(encoded, maxBytes)).toBeNull();
  });

  it("valid base64 at exact boundary returns Buffer", () => {
    const { decodeStrictBase64 } = subagentSpawnModule;
    const exactBuf = Buffer.alloc(1024, 0x41);
    const encoded = exactBuf.toString("base64");
    const result = decodeStrictBase64(encoded, maxBytes);
    expect(result?.byteLength).toBe(1024);
  });
});

// --- filename validation via spawnSubagentDirect ---

describe("spawnSubagentDirect filename validation", () => {
  beforeEach(async () => {
    workspaceDirOverride = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-attachments-${process.pid}-${Date.now()}-`),
    );
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride);
    subagentSpawnModule.resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    upsertSessionEntryMock.mockReset();
    sessionStore = {};
    upsertSessionEntryMock.mockImplementation(() => undefined);
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  afterEach(() => {
    if (workspaceDirOverride) {
      fs.rmSync(workspaceDirOverride, { recursive: true, force: true });
      workspaceDirOverride = "";
    }
  });

  const ctx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "forum" as const,
    agentAccountId: "123",
    agentTo: "456",
  };

  const validContent = Buffer.from("hello").toString("base64");

  async function spawnWithName(name: string) {
    const { spawnSubagentDirect } = subagentSpawnModule;
    return spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name, content: validContent, encoding: "base64" }],
      },
      ctx,
    );
  }

  it("name with / returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo/bar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '..' returns attachments_invalid_name", async () => {
    const result = await spawnWithName("..");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '.manifest.json' returns attachments_invalid_name", async () => {
    const result = await spawnWithName(".manifest.json");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name with newline returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo\nbar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("duplicate name returns attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "file.txt", content: validContent, encoding: "base64" },
          { name: "file.txt", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });

  it("empty name returns attachments_invalid_name", async () => {
    const result = await spawnWithName("");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("passes attachments as initial SQLite VFS seed entries for worker runs", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      return { ok: true };
    });

    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          {
            name: "file.txt",
            content: Buffer.from("hello").toString("base64"),
            encoding: "base64",
            mimeType: "text/plain",
          },
        ],
      },
      ctx,
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((entry) => entry.method === "agent");
    const initialVfsEntries = agentCall?.params?.initialVfsEntries;
    expect(initialVfsEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/^\.openclaw\/attachments\/[^/]+\/file\.txt$/),
          contentBase64: Buffer.from("hello").toString("base64"),
          metadata: expect.objectContaining({
            source: "subagent-attachment",
            name: "file.txt",
            mimeType: "text/plain",
          }),
        }),
        expect.objectContaining({
          path: expect.stringMatching(/^\.openclaw\/attachments\/[^/]+\/\.manifest\.json$/),
          metadata: { source: "subagent-attachment-manifest" },
        }),
      ]),
    );
  });

  it("keeps attachments out of the workspace filesystem when lineage patching fails", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    sessionStore = {};
    upsertSessionEntryMock.mockImplementation((options: { entry?: Record<string, unknown> }) => {
      if (typeof options.entry?.spawnedBy === "string") {
        throw new Error("lineage patch failed");
      }
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("lineage patch failed");
    const attachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
    expect(fs.existsSync(attachmentsRoot)).toBe(false);
    const deleteCall = calls.find((entry) => entry.method === "sessions.delete");
    const deleteParams = deleteCall?.params as
      | {
          key?: string;
          deleteTranscript?: boolean;
          emitLifecycleHooks?: boolean;
        }
      | undefined;
    expect(deleteParams?.key).toMatch(/^agent:main:subagent:/);
    expect(deleteParams?.deleteTranscript).toBe(true);
    expect(deleteParams?.emitLifecycleHooks).toBe(false);
  });
});
