import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock active-runs module
vi.mock("@/lib/active-runs", () => ({
  startRun: vi.fn(),
  hasActiveRun: vi.fn(() => false),
  subscribeToRun: vi.fn(),
  persistUserMessage: vi.fn(),
  abortRun: vi.fn(() => false),
  getActiveRun: vi.fn(),
  getRunningSessionIds: vi.fn(() => []),
}));

// Mock workspace module
vi.mock("@/lib/workspace", () => ({
  ensureManagedWorkspaceRouting: vi.fn(),
  getActiveWorkspaceName: vi.fn(() => "default"),
  resolveActiveAgentId: vi.fn(() => "main"),
  resolveAgentWorkspacePrefix: vi.fn(() => null),
  resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
  resolveWorkspaceDirForName: vi.fn((name: string) =>
    name === "default"
      ? "/home/testuser/.openclaw-dench/workspace"
      : `/home/testuser/.openclaw-dench/workspace-${name}`,
  ),
  resolveWorkspaceRoot: vi.fn(() => "/home/testuser/.openclaw-dench/workspace"),
}));

// Mock web-sessions shared module
vi.mock("@/app/api/web-sessions/shared", () => ({
  getSessionMeta: vi.fn(() => undefined),
  resolveSessionKey: vi.fn(
    (sessionId: string, fallbackAgentId: string) =>
      `agent:${fallbackAgentId}:web:${sessionId}`,
  ),
  resolveSessionAgentId: vi.fn(
    (_sessionId: string, fallbackAgentId: string) => fallbackAgentId,
  ),
}));

describe("Chat API routes", () => {
  beforeEach(() => {
    vi.resetModules();
    // Re-wire mocks
    vi.mock("@/lib/active-runs", () => ({
      startRun: vi.fn(),
      hasActiveRun: vi.fn(() => false),
      subscribeToRun: vi.fn(),
      persistUserMessage: vi.fn(),
      abortRun: vi.fn(() => false),
      getActiveRun: vi.fn(),
      getRunningSessionIds: vi.fn(() => []),
    }));
    vi.mock("@/lib/workspace", () => ({
      ensureManagedWorkspaceRouting: vi.fn(),
      getActiveWorkspaceName: vi.fn(() => "default"),
      resolveActiveAgentId: vi.fn(() => "main"),
      resolveAgentWorkspacePrefix: vi.fn(() => null),
      resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
      resolveWorkspaceDirForName: vi.fn((name: string) =>
        name === "default"
          ? "/home/testuser/.openclaw-dench/workspace"
          : `/home/testuser/.openclaw-dench/workspace-${name}`,
      ),
      resolveWorkspaceRoot: vi.fn(() => "/home/testuser/.openclaw-dench/workspace"),
    }));
    vi.mock("@/app/api/web-sessions/shared", () => ({
      getSessionMeta: vi.fn(() => undefined),
      resolveSessionKey: vi.fn(
        (sessionId: string, fallbackAgentId: string) =>
          `agent:${fallbackAgentId}:web:${sessionId}`,
      ),
      resolveSessionAgentId: vi.fn(
        (_sessionId: string, fallbackAgentId: string) => fallbackAgentId,
      ),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── POST /api/chat ──────────────────────────────────────────────

  describe("POST /api/chat", () => {
    it("returns 400 when no user message text", async () => {
      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "" }] }],
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("returns 409 when active run exists for session", async () => {
      const { hasActiveRun } = await import("@/lib/active-runs");
      vi.mocked(hasActiveRun).mockReturnValue(true);

      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
          sessionId: "s1",
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(409);
    });

    it("starts a run and returns streaming response", async () => {
      const { startRun, hasActiveRun, subscribeToRun } = await import("@/lib/active-runs");
      vi.mocked(hasActiveRun).mockReturnValue(false);
      vi.mocked(subscribeToRun).mockReturnValue(() => {});

      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
          ],
          sessionId: "s1",
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(startRun).toHaveBeenCalled();
    });

    it("maps partial tool output into AI SDK preliminary output chunks", async () => {
      const { hasActiveRun, subscribeToRun } = await import("@/lib/active-runs");
      vi.mocked(hasActiveRun).mockReturnValue(false);
      vi.mocked(subscribeToRun).mockImplementation(((_sessionId, callback) => {
        callback({
          type: "tool-output-partial",
          toolCallId: "tool-1",
          output: { text: "partial output" },
        } as never);
        callback(null);
        return () => {};
      }) as never);

      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
          ],
          sessionId: "s1",
        }),
      });
      const res = await POST(req);
      const body = await res.text();

      expect(body).toContain('"type":"tool-output-available"');
      expect(body).toContain('"toolCallId":"tool-1"');
      expect(body).toContain('"preliminary":true');
      expect(body).toContain('"text":"partial output"');
      expect(body).not.toContain("tool-output-partial");
    });

    it("does not reuse an old run when sessionId is absent", async () => {
      const { startRun, hasActiveRun, subscribeToRun, persistUserMessage } = await import("@/lib/active-runs");
      vi.mocked(hasActiveRun).mockReturnValue(true);
      vi.mocked(subscribeToRun).mockReturnValue(() => {});
      vi.mocked(hasActiveRun).mockClear();
      vi.mocked(startRun).mockClear();
      vi.mocked(persistUserMessage).mockClear();

      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "new workspace question" }] },
          ],
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(hasActiveRun).not.toHaveBeenCalled();
      expect(startRun).not.toHaveBeenCalled();
      expect(persistUserMessage).not.toHaveBeenCalled();
    });

    it("persists user message when sessionId provided", async () => {
      const { hasActiveRun, subscribeToRun, persistUserMessage } = await import("@/lib/active-runs");
      vi.mocked(hasActiveRun).mockReturnValue(false);
      vi.mocked(subscribeToRun).mockReturnValue(() => {});

      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
          ],
          sessionId: "s1",
        }),
      });
      await POST(req);
      expect(persistUserMessage).toHaveBeenCalledWith("s1", expect.objectContaining({ id: "m1" }));
    });

    it("repairs managed workspace routing before starting a persisted session run", async () => {
      const { ensureManagedWorkspaceRouting } = await import("@/lib/workspace");
      const { getSessionMeta } = await import("@/app/api/web-sessions/shared");
      const { startRun, hasActiveRun, subscribeToRun } = await import("@/lib/active-runs");
      vi.mocked(hasActiveRun).mockReturnValue(false);
      vi.mocked(subscribeToRun).mockReturnValue(() => {});
      vi.mocked(getSessionMeta).mockReturnValue({
        id: "s1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        workspaceName: "default",
        workspaceRoot: "/home/testuser/.openclaw-dench/workspace",
        workspaceAgentId: "main",
        chatAgentId: "chat-slot-main-2",
      } as never);

      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "repair routing" }] },
          ],
          sessionId: "s1",
        }),
      });
      await POST(req);
      expect(ensureManagedWorkspaceRouting).toHaveBeenCalledWith(
        "default",
        "/home/testuser/.openclaw-dench/workspace",
        { markDefault: false },
      );
      expect(startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          overrideAgentId: "chat-slot-main-2",
        }),
      );
    });

    it("resolves workspace file paths in message", async () => {
      const { resolveAgentWorkspacePrefix } = await import("@/lib/workspace");
      vi.mocked(resolveAgentWorkspacePrefix).mockReturnValue("workspace");
      const { startRun, hasActiveRun, subscribeToRun } = await import("@/lib/active-runs");
      vi.mocked(hasActiveRun).mockReturnValue(false);
      vi.mocked(subscribeToRun).mockReturnValue(() => {});

      const { POST } = await import("./route.js");
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "[Context: workspace file 'doc.md']" }],
            },
          ],
          sessionId: "s1",
        }),
      });
      await POST(req);
      expect(startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("workspace/doc.md"),
        }),
      );
    });
  });

  // ─── POST /api/chat/stop ────────────────────────────────────────

  describe("POST /api/chat/stop", () => {
    it("returns 400 when sessionId missing", async () => {
      const { POST } = await import("./stop/route.js");
      const req = new Request("http://localhost/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("aborts run and returns result", async () => {
      const { abortRun, getActiveRun } = await import("@/lib/active-runs");
      vi.mocked(getActiveRun).mockReturnValue({ status: "running" } as never);
      vi.mocked(abortRun).mockReturnValue(true);

      const { POST } = await import("./stop/route.js");
      const req = new Request("http://localhost/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.aborted).toBe(true);
    });

    it("returns aborted=false for unknown session", async () => {
      const { abortRun } = await import("@/lib/active-runs");
      vi.mocked(abortRun).mockReturnValue(false);

      const { POST } = await import("./stop/route.js");
      const req = new Request("http://localhost/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "nonexistent" }),
      });
      const res = await POST(req);
      const json = await res.json();
      expect(json.aborted).toBe(false);
    });

    it("handles invalid JSON body gracefully", async () => {
      const { POST } = await import("./stop/route.js");
      const req = new Request("http://localhost/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/chat/active ────────────────────────────────────────

  describe("GET /api/chat/active", () => {
    it("returns empty sessionIds when no active runs", async () => {
      const { GET } = await import("./active/route.js");
      const res = GET();
      const json = await res.json();
      expect(json.sessionIds).toEqual([]);
    });

    it("returns active session IDs", async () => {
      const { getRunningSessionIds } = await import("@/lib/active-runs");
      vi.mocked(getRunningSessionIds).mockReturnValue(["s1", "s2"]);

      const { GET } = await import("./active/route.js");
      const res = GET();
      const json = await res.json();
      expect(json.sessionIds).toEqual(["s1", "s2"]);
    });
  });

  // ─── GET /api/chat/stream ───────────────────────────────────────

  describe("GET /api/chat/stream", () => {
    it("returns 400 when sessionId is missing", async () => {
      const { GET } = await import("./stream/route.js");
      const req = new Request("http://localhost/api/chat/stream");
      const res = await GET(req);
      expect(res.status).toBe(400);
    });

    it("returns 404 when no run exists for session", async () => {
      const { getActiveRun } = await import("@/lib/active-runs");
      vi.mocked(getActiveRun).mockReturnValue(undefined);

      const { GET } = await import("./stream/route.js");
      const req = new Request("http://localhost/api/chat/stream?sessionId=nonexistent");
      const res = await GET(req);
      expect(res.status).toBe(404);
    });

    it("returns SSE stream for active run", async () => {
      const { getActiveRun, subscribeToRun } = await import("@/lib/active-runs");
      vi.mocked(getActiveRun).mockReturnValue({ status: "running" } as never);
      vi.mocked(subscribeToRun).mockReturnValue(() => {});

      const { GET } = await import("./stream/route.js");
      const req = new Request("http://localhost/api/chat/stream?sessionId=s1");
      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("X-Run-Active")).toBe("true");
    });

    it("returns X-Run-Active=false for completed run", async () => {
      const { getActiveRun, subscribeToRun } = await import("@/lib/active-runs");
      vi.mocked(getActiveRun).mockReturnValue({ status: "completed" } as never);
      vi.mocked(subscribeToRun).mockReturnValue(() => {});

      const { GET } = await import("./stream/route.js");
      const req = new Request("http://localhost/api/chat/stream?sessionId=s1");
      const res = await GET(req);
      expect(res.headers.get("X-Run-Active")).toBe("false");
    });
  });
});
