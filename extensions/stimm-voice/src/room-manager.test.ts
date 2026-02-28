import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateRoom = vi.fn(async () => ({}));
const mockDeleteRoom = vi.fn(async () => {});
const mockCreateDispatch = vi.fn(async () => ({}));
const mockAddGrant = vi.fn();
const mockToJwt = vi.fn(async () => "mock-jwt-token");

vi.mock("livekit-server-sdk", () => {
  return {
    RoomServiceClient: class FakeRoomService {
      constructor() {}
      createRoom = mockCreateRoom;
      deleteRoom = mockDeleteRoom;
    },
    AgentDispatchClient: class FakeDispatchClient {
      constructor() {}
      createDispatch = mockCreateDispatch;
    },
    AccessToken: class FakeAccessToken {
      constructor() {}
      addGrant(grant: unknown) {
        mockAddGrant(grant);
      }
      async toJwt() {
        return mockToJwt();
      }
    },
  };
});

const { LiveKitRuntime } = await import("../index.ts");

function createRuntime() {
  return new LiveKitRuntime({
    enabled: true,
    livekit: { url: "ws://localhost:7880", apiKey: "devkey", apiSecret: "secret" },
    voiceAgent: {
      docker: true,
      image: "ghcr.io/stimm-ai/stimm-agent:latest",
      stt: { provider: "deepgram", model: "nova-3" },
      tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "ash" },
      llm: { provider: "openai", model: "gpt-4o-mini" },
      bufferingLevel: "MEDIUM",
      mode: "hybrid",
      spawn: { autoSpawn: false, maxRestarts: 5 },
    },
    web: { enabled: true, path: "/voice" },
    access: {
      mode: "none",
      claimTtlSeconds: 120,
      livekitTokenTtlSeconds: 300,
      allowDirectWebSessionCreate: false,
      claimRateLimitPerMinute: 20,
    },
  });
}

describe("LiveKitRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSession", () => {
    it("creates a room, dispatches worker, and returns a tokenized session", async () => {
      const runtime = createRuntime();
      const session = await runtime.createSession({ originChannel: "web" });

      expect(mockCreateRoom).toHaveBeenCalled();
      expect(mockCreateDispatch).toHaveBeenCalled();
      expect(mockAddGrant).toHaveBeenCalled();
      expect(session.roomName).toMatch(/^stimm-/);
      expect(session.clientToken).toBe("mock-jwt-token");
      expect(session.originChannel).toBe("web");
      expect(session.createdAt).toBeGreaterThan(0);
    });

    it("uses a custom room name when provided", async () => {
      const runtime = createRuntime();
      const session = await runtime.createSession({
        roomName: "my-custom-room",
        originChannel: "telegram",
      });

      expect(session.roomName).toBe("my-custom-room");
      expect(session.originChannel).toBe("telegram");
    });

    it("stores the session for later retrieval", async () => {
      const runtime = createRuntime();
      const session = await runtime.createSession({
        roomName: "lookupable",
        originChannel: "web",
      });

      const found = runtime.getSession("lookupable");
      expect(found).toBeDefined();
      expect(found!.roomName).toBe(session.roomName);
    });

    it("rolls back the room when dispatch creation fails", async () => {
      const runtime = createRuntime();
      mockCreateDispatch.mockRejectedValueOnce(new Error("dispatch unavailable"));

      await expect(
        runtime.createSession({ roomName: "rollback-room", originChannel: "web" }),
      ).rejects.toThrow("dispatch unavailable");

      expect(mockCreateRoom).toHaveBeenCalledWith({ name: "rollback-room", emptyTimeout: 600 });
      expect(mockDeleteRoom).toHaveBeenCalledWith("rollback-room");
      expect(runtime.getSession("rollback-room")).toBeUndefined();
    });
  });

  describe("endSession", () => {
    it("deletes room and removes the session from map", async () => {
      const runtime = createRuntime();
      await runtime.createSession({
        roomName: "to-end",
        originChannel: "web",
      });

      const ok = await runtime.endSession("to-end");
      expect(ok).toBe(true);
      expect(mockDeleteRoom).toHaveBeenCalledWith("to-end");
      expect(runtime.getSession("to-end")).toBeUndefined();
    });

    it("attempts remote teardown for unknown room and returns true when delete succeeds", async () => {
      const runtime = createRuntime();
      const ok = await runtime.endSession("nonexistent");
      expect(ok).toBe(true);
      expect(mockDeleteRoom).toHaveBeenCalledWith("nonexistent");
    });

    it("returns false when unknown room teardown also fails remotely", async () => {
      const runtime = createRuntime();
      mockDeleteRoom.mockRejectedValueOnce(new Error("room not found"));

      const ok = await runtime.endSession("nonexistent");
      expect(ok).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("returns all active sessions", async () => {
      const runtime = createRuntime();
      await runtime.createSession({ roomName: "a", originChannel: "web" });
      await runtime.createSession({ roomName: "b", originChannel: "telegram" });

      const list = runtime.listSessions();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.roomName).sort()).toEqual(["a", "b"]);
    });
  });

  describe("stopAll", () => {
    it("ends all sessions", async () => {
      const runtime = createRuntime();
      await runtime.createSession({ roomName: "x", originChannel: "web" });
      await runtime.createSession({ roomName: "y", originChannel: "web" });

      await runtime.stopAll();
      expect(runtime.listSessions()).toHaveLength(0);
      expect(mockDeleteRoom).toHaveBeenCalledTimes(2);
    });
  });

  describe("issueClientToken", () => {
    it("issues token for existing session", async () => {
      const runtime = createRuntime();
      await runtime.createSession({ roomName: "token-room", originChannel: "web" });

      const token = await runtime.issueClientToken("token-room");
      expect(token).toBe("mock-jwt-token");
    });

    it("throws when session is missing", async () => {
      const runtime = createRuntime();
      await expect(runtime.issueClientToken("missing-room")).rejects.toThrow("session not found");
    });
  });

  describe("getSession", () => {
    it("returns undefined for missing session", () => {
      const runtime = createRuntime();
      expect(runtime.getSession("nope")).toBeUndefined();
    });
  });
});
