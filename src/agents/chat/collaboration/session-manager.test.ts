import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSession,
  getSession,
  getActiveSession,
  pauseSession,
  resumeSession,
  completeSession,
  cancelSession,
  addParticipant,
  removeParticipant,
  recordContribution,
  getActiveParticipants,
  isParticipant,
  listSessions,
  onCollaborationEvent,
  emitRoundStarted,
  emitRoundCompleted,
  emitExpertActivated,
  emitHandoffRequested,
  emitHandoffAccepted,
} from "./session-manager.js";

const mockDbClient = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
};

vi.mock("../db/client.js", () => ({
  getChatDbClient: () => mockDbClient,
  toJsonb: (v: unknown) => JSON.stringify(v),
  fromJsonb: <T>(v: string | null): T | null => {
    if (v == null) {
      return null;
    }
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  },
}));

describe("session-manager", () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbClient.execute.mockResolvedValue({ rowCount: 1 });
    mockDbClient.query.mockResolvedValue([]);
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  describe("createSession", () => {
    it("should create a new collaboration session", async () => {
      const session = await createSession({
        channelId: "chan_456",
        mode: "war-room",
        participantIds: ["agent1", "agent2"],
      });

      expect(session.sessionId).toMatch(/^collab_/);
      expect(session.channelId).toBe("chan_456");
      expect(session.mode).toBe("war-room");
      expect(session.status).toBe("active");
      expect(session.participants).toHaveLength(2);
      expect(session.roundCount).toBe(0);
    });

    it("should set coordinator for coordinator mode", async () => {
      const session = await createSession({
        channelId: "chan_456",
        mode: "coordinator",
        coordinatorId: "agent1",
        participantIds: ["agent1", "agent2"],
      });

      expect(session.coordinator).toBe("agent1");
      const coordinatorParticipant = session.participants.find((p) => p.agentId === "agent1");
      expect(coordinatorParticipant?.role).toBe("coordinator");
    });

    it("should emit session.started event", async () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      await createSession({
        channelId: "chan_456",
        mode: "war-room",
        participantIds: ["agent1"],
      });

      expect(events).toHaveLength(1);
      expect((events[0] as { type: string }).type).toBe("session.started");
    });
  });

  describe("getSession", () => {
    it("should retrieve session by ID", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        session_id: "collab_123",
        channel_id: "chan_456",
        mode: "war-room",
        coordinator_id: null,
        status: "active",
        config: "{}",
        created_at: now,
        updated_at: null,
        completed_at: null,
      });
      mockDbClient.query.mockResolvedValueOnce([
        {
          session_id: "collab_123",
          agent_id: "agent1",
          role: "participant",
          expertise: null,
          joined_at: now,
          left_at: null,
          contribution_count: 0,
        },
      ]);

      const session = await getSession("collab_123");

      expect(session?.sessionId).toBe("collab_123");
      expect(session?.participants).toHaveLength(1);
    });

    it("should return null for non-existent session", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce(null);

      const session = await getSession("nonexistent");

      expect(session).toBeNull();
    });
  });

  describe("getActiveSession", () => {
    it("should return active session for channel", async () => {
      const now = new Date();
      mockDbClient.queryOne.mockResolvedValueOnce({
        session_id: "collab_123",
        channel_id: "chan_456",
        mode: "war-room",
        coordinator_id: null,
        status: "active",
        config: "{}",
        created_at: now,
        updated_at: null,
        completed_at: null,
      });
      mockDbClient.query.mockResolvedValueOnce([]);

      const session = await getActiveSession("chan_456");

      expect(session?.sessionId).toBe("collab_123");
    });

    it("should return null when no active session", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce(null);

      const session = await getActiveSession("chan_456");

      expect(session).toBeNull();
    });
  });

  describe("pauseSession", () => {
    it("should set status to paused", async () => {
      await pauseSession("collab_123", "User requested pause");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'paused'"),
        ["collab_123"],
      );
    });

    it("should emit session.paused event", async () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      await pauseSession("collab_123");

      expect(events.some((e) => (e as { type: string }).type === "session.paused")).toBe(true);
    });
  });

  describe("resumeSession", () => {
    it("should set status to active", async () => {
      await resumeSession("collab_123");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'active'"),
        ["collab_123"],
      );
    });
  });

  describe("completeSession", () => {
    it("should set status to completed", async () => {
      await completeSession("collab_123");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'completed'"),
        ["collab_123"],
      );
    });

    it("should emit session.completed event", async () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      await completeSession("collab_123", { summary: "Done" });

      expect(events.some((e) => (e as { type: string }).type === "session.completed")).toBe(true);
    });
  });

  describe("cancelSession", () => {
    it("should set status to cancelled", async () => {
      await cancelSession("collab_123", "No longer needed");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
        ["collab_123"],
      );
    });
  });

  describe("addParticipant", () => {
    it("should add participant to session", async () => {
      const participant = await addParticipant("collab_123", "agent3");

      expect(participant.agentId).toBe("agent3");
      expect(participant.role).toBe("participant");
      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO collaboration_participants"),
        expect.any(Array),
      );
    });

    it("should emit participant.joined event", async () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      await addParticipant("collab_123", "agent3");

      expect(events.some((e) => (e as { type: string }).type === "participant.joined")).toBe(true);
    });
  });

  describe("removeParticipant", () => {
    it("should mark participant as left", async () => {
      await removeParticipant("collab_123", "agent2");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("left_at = NOW()"),
        ["collab_123", "agent2"],
      );
    });

    it("should emit participant.left event", async () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      await removeParticipant("collab_123", "agent2");

      expect(events.some((e) => (e as { type: string }).type === "participant.left")).toBe(true);
    });
  });

  describe("recordContribution", () => {
    it("should increment contribution count", async () => {
      await recordContribution("collab_123", "agent1");

      expect(mockDbClient.execute).toHaveBeenCalledWith(
        expect.stringContaining("contribution_count = contribution_count + 1"),
        ["collab_123", "agent1"],
      );
    });
  });

  describe("getActiveParticipants", () => {
    it("should return participants that have not left", async () => {
      const now = new Date();
      mockDbClient.query.mockResolvedValueOnce([
        {
          session_id: "collab_123",
          agent_id: "agent1",
          role: "participant",
          expertise: null,
          joined_at: now,
          left_at: null,
          contribution_count: 3,
        },
        {
          session_id: "collab_123",
          agent_id: "agent2",
          role: "coordinator",
          expertise: null,
          joined_at: now,
          left_at: null,
          contribution_count: 1,
        },
      ]);

      const participants = await getActiveParticipants("collab_123");

      expect(participants).toHaveLength(2);
      expect(participants[0].agentId).toBe("agent1");
    });
  });

  describe("isParticipant", () => {
    it("should return true for active participant", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce({ count: "1" });

      const result = await isParticipant("collab_123", "agent1");

      expect(result).toBe(true);
    });

    it("should return false for non-participant", async () => {
      mockDbClient.queryOne.mockResolvedValueOnce({ count: "0" });

      const result = await isParticipant("collab_123", "unknown");

      expect(result).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("should return sessions for a channel", async () => {
      const now = new Date();
      mockDbClient.query
        .mockResolvedValueOnce([
          {
            session_id: "collab_1",
            channel_id: "chan_456",
            mode: "war-room",
            coordinator_id: null,
            status: "active",
            config: "{}",
            created_at: now,
            updated_at: null,
            completed_at: null,
          },
        ])
        .mockResolvedValueOnce([]); // participants

      const sessions = await listSessions("chan_456");

      expect(sessions).toHaveLength(1);
    });

    it("should filter by status", async () => {
      mockDbClient.query.mockResolvedValueOnce([]);

      await listSessions("chan_456", { status: "completed" });

      expect(mockDbClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status = $2"),
        expect.arrayContaining(["chan_456", "completed"]),
      );
    });
  });

  describe("event emission helpers", () => {
    it("emitRoundStarted should emit round.started event", () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      emitRoundStarted("collab_123", 1, ["agent1", "agent2"]);

      expect(events).toHaveLength(1);
      expect((events[0] as { type: string }).type).toBe("round.started");
      expect((events[0] as { roundNumber: number }).roundNumber).toBe(1);
    });

    it("emitRoundCompleted should emit round.completed event", () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      emitRoundCompleted("collab_123", 1, [
        { agentId: "agent1", content: "Response 1", timestamp: Date.now() },
      ]);

      expect((events[0] as { type: string }).type).toBe("round.completed");
    });

    it("emitExpertActivated should emit expert.activated event", () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      emitExpertActivated("collab_123", "agent1", "code");

      expect((events[0] as { type: string }).type).toBe("expert.activated");
      expect((events[0] as { topic: string }).topic).toBe("code");
    });

    it("emitHandoffRequested should emit handoff.requested event", () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      emitHandoffRequested("collab_123", "agent1", "agent2", "Need specialist");

      expect((events[0] as { type: string }).type).toBe("handoff.requested");
      expect((events[0] as { fromAgent: string }).fromAgent).toBe("agent1");
      expect((events[0] as { toAgent: string }).toAgent).toBe("agent2");
    });

    it("emitHandoffAccepted should emit handoff.accepted event", () => {
      const events: unknown[] = [];
      unsubscribe = onCollaborationEvent((e) => events.push(e));

      emitHandoffAccepted("collab_123", "agent2");

      expect((events[0] as { type: string }).type).toBe("handoff.accepted");
    });
  });

  describe("onCollaborationEvent", () => {
    it("should return unsubscribe function", () => {
      const listener = vi.fn();
      const unsub = onCollaborationEvent(listener);

      emitRoundStarted("collab_123", 1, []);
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      emitRoundStarted("collab_123", 2, []);
      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });
  });
});
