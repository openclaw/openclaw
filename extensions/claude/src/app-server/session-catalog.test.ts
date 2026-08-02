import { describe, expect, it, vi } from "vitest";
import { ClaudeAppServerRpcError, type ClaudeAppServerClient } from "./client.js";
import {
  archiveClaudeSession,
  ClaudeSessionNotFoundError,
  listClaudeSessions,
  readClaudeSession,
  renameClaudeSession,
  unarchiveClaudeSession,
} from "./session-catalog.js";

function makeClient(
  request: (method: string, params?: unknown) => Promise<unknown>,
): ClaudeAppServerClient {
  return { request } as unknown as ClaudeAppServerClient;
}

const SAMPLE_THREAD = {
  id: "t1",
  sessionId: "t1",
  name: "Debugging session",
  cwd: "/home/eddie/repo",
  status: { type: "idle" },
  createdAt: 1000,
  updatedAt: 2000,
  source: "appServer",
  modelProvider: "anthropic",
  preview: "how does auth work?",
  archived: false,
};

describe("listClaudeSessions", () => {
  it("maps thread/list's response into catalog sessions and forwards query params", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("thread/list");
      expect(params).toMatchObject({ limit: 25, archived: true, searchTerm: "auth" });
      return { data: [SAMPLE_THREAD], nextCursor: "t1" };
    });
    const page = await listClaudeSessions(makeClient(request), {
      limit: 25,
      archived: true,
      searchTerm: "auth",
    });
    expect(page.nextCursor).toBe("t1");
    expect(page.sessions).toEqual([
      {
        threadId: "t1",
        sessionId: "t1",
        name: "Debugging session",
        cwd: "/home/eddie/repo",
        status: "idle",
        createdAt: 1000,
        updatedAt: 2000,
        source: "appServer",
        modelProvider: "anthropic",
        preview: "how does auth work?",
        archived: false,
      },
    ]);
  });

  it("defaults archived to false when omitted", async () => {
    const request = vi.fn(async (_method: string, params?: unknown) => {
      expect((params as { archived: boolean }).archived).toBe(false);
      return { data: [] };
    });
    await listClaudeSessions(makeClient(request), {});
  });
});

describe("readClaudeSession", () => {
  it("flattens the single synthetic turn's items", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({ threadId: "t1", includeTurns: true });
      return {
        thread: {
          ...SAMPLE_THREAD,
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: [
                { id: "i1", type: "userMessage", text: "hi" },
                { id: "i2", type: "agentMessage", text: "hello" },
              ],
            },
          ],
        },
      };
    });
    const result = await readClaudeSession(makeClient(request), "t1");
    expect(result.session.threadId).toBe("t1");
    expect(result.items).toEqual([
      { id: "i1", type: "userMessage", name: null, text: "hi" },
      { id: "i2", type: "agentMessage", name: null, text: "hello" },
    ]);
  });

  it("throws ClaudeSessionNotFoundError on the bridge's thread-not-found code", async () => {
    const request = vi.fn(async () => {
      throw new ClaudeAppServerRpcError("Thread not found: nope", -32004);
    });
    await expect(readClaudeSession(makeClient(request), "nope")).rejects.toThrow(
      ClaudeSessionNotFoundError,
    );
  });

  it("re-throws other RPC errors unchanged", async () => {
    const request = vi.fn(async () => {
      throw new ClaudeAppServerRpcError("boom", -32603);
    });
    await expect(readClaudeSession(makeClient(request), "t1")).rejects.toThrow("boom");
  });
});

describe("renameClaudeSession / archiveClaudeSession / unarchiveClaudeSession", () => {
  it("calls the matching bridge RPC with the right params", async () => {
    const request = vi.fn(async () => ({}));
    const client = makeClient(request);

    await renameClaudeSession(client, "t1", "New name");
    expect(request).toHaveBeenCalledWith("thread/name/set", { threadId: "t1", name: "New name" });

    await archiveClaudeSession(client, "t1");
    expect(request).toHaveBeenCalledWith("thread/archive", { threadId: "t1" });
  });

  it("unarchive maps the restored thread back into a catalog session", async () => {
    const request = vi.fn(async () => ({ thread: { ...SAMPLE_THREAD, archived: false } }));
    const session = await unarchiveClaudeSession(makeClient(request), "t1");
    expect(session.threadId).toBe("t1");
    expect(session.archived).toBe(false);
  });
});
