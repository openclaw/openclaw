import { describe, it, expect, vi } from "vitest";
import type { CollaborationSession, AgentResponse } from "./types.js";
import {
  coordinateMessage,
  getNextInChain,
  checkConsensus,
  aggregateResponses,
} from "./coordinator.js";

// Mock session-manager (coordinateMessage does not use it directly, but requestHandoff does)
vi.mock("./session-manager.js", () => ({
  getActiveSession: vi.fn(),
  emitExpertActivated: vi.fn(),
  emitHandoffRequested: vi.fn(),
  emitHandoffAccepted: vi.fn(),
  recordContribution: vi.fn(),
}));

// Mock routing modules
vi.mock("../routing/mention-parser.js", () => ({
  parseMentions: vi.fn(),
  matchPatternMentions: vi.fn(),
}));

vi.mock("../routing/router.js", () => ({
  resolveTargetAgents: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  getChatDbClient: () => ({
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
  }),
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

describe("coordinator", () => {
  const makeSession = (overrides?: Partial<CollaborationSession>): CollaborationSession => ({
    sessionId: "collab_123",
    channelId: "chan_456",
    mode: "war-room",
    participants: [
      { agentId: "agent1", role: "participant", joinedAt: 0, contributionCount: 0 },
      { agentId: "agent2", role: "participant", joinedAt: 0, contributionCount: 0 },
    ],
    status: "active",
    config: {},
    createdAt: Date.now(),
    roundCount: 0,
    ...overrides,
  });

  describe("coordinateMessage", () => {
    it("should broadcast to all participants in war-room mode", async () => {
      const session = makeSession({ mode: "war-room" });

      const decision = await coordinateMessage(session, "What do you think?", "user1");

      expect(decision.targetAgents).toContain("agent1");
      expect(decision.targetAgents).toContain("agent2");
      expect(decision.reason).toBe("war_room_broadcast");
    });

    it("should exclude the author from war-room targets", async () => {
      const session = makeSession({ mode: "war-room" });

      const decision = await coordinateMessage(session, "What do you think?", "agent1");

      expect(decision.targetAgents).not.toContain("agent1");
      expect(decision.targetAgents).toContain("agent2");
    });

    it("should follow chain order in chain-of-thought mode", async () => {
      const session = makeSession({
        mode: "chain-of-thought",
        config: { chainOrder: ["agent1", "agent2", "agent3"] },
        participants: [
          { agentId: "agent1", role: "participant", joinedAt: 0, contributionCount: 0 },
          { agentId: "agent2", role: "participant", joinedAt: 0, contributionCount: 0 },
          { agentId: "agent3", role: "participant", joinedAt: 0, contributionCount: 0 },
        ],
      });

      // Start of chain (user is not in chain)
      const decision1 = await coordinateMessage(session, "Start", "user1");
      expect(decision1.targetAgents).toEqual(["agent1"]);

      // Agent1 responds, next is agent2
      const decision2 = await coordinateMessage(session, "Step 1 done", "agent1");
      expect(decision2.targetAgents).toEqual(["agent2"]);

      // Agent2 responds, next is agent3
      const decision3 = await coordinateMessage(session, "Step 2 done", "agent2");
      expect(decision3.targetAgents).toEqual(["agent3"]);
    });

    it("should end chain when last agent responds (non-loop)", async () => {
      const session = makeSession({
        mode: "chain-of-thought",
        config: { chainOrder: ["agent1", "agent2"] },
      });

      const decision = await coordinateMessage(session, "Final step", "agent2");

      expect(decision.targetAgents).toEqual([]);
      expect(decision.reason).toBe("chain_complete");
    });

    it("should loop back in chain-of-thought with isLoop=true", async () => {
      const session = makeSession({
        mode: "chain-of-thought",
        config: { chainOrder: ["agent1", "agent2"], isLoop: true },
      });

      const decision = await coordinateMessage(session, "Another round", "agent2");

      expect(decision.targetAgents).toEqual(["agent1"]);
    });

    it("should request votes from all participants in consensus mode", async () => {
      const session = makeSession({
        mode: "consensus",
        participants: [
          { agentId: "agent1", role: "participant", joinedAt: 0, contributionCount: 0 },
          { agentId: "agent2", role: "participant", joinedAt: 0, contributionCount: 0 },
          { agentId: "observer", role: "observer", joinedAt: 0, contributionCount: 0 },
        ],
      });

      const decision = await coordinateMessage(session, "Should we merge?", "user1");

      expect(decision.targetAgents).toContain("agent1");
      expect(decision.targetAgents).toContain("agent2");
      expect(decision.targetAgents).not.toContain("observer");
      expect(decision.reason).toBe("consensus_vote_request");
    });

    it("should return unknown_mode for unrecognized modes", async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const session = makeSession({ mode: "unknown" as any });

      const decision = await coordinateMessage(session, "Hello", "user1");

      expect(decision.targetAgents).toEqual([]);
      expect(decision.reason).toBe("unknown_mode");
    });
  });

  describe("getNextInChain", () => {
    it("should return next agent in chain", () => {
      const session = makeSession({
        mode: "chain-of-thought",
        config: { chainOrder: ["agent1", "agent2", "agent3"] },
      });

      expect(getNextInChain(session, "agent1")).toBe("agent2");
      expect(getNextInChain(session, "agent2")).toBe("agent3");
    });

    it("should return null at end of non-looping chain", () => {
      const session = makeSession({
        mode: "chain-of-thought",
        config: { chainOrder: ["agent1", "agent2"] },
      });

      expect(getNextInChain(session, "agent2")).toBeNull();
    });

    it("should loop back for looping chain", () => {
      const session = makeSession({
        mode: "chain-of-thought",
        config: { chainOrder: ["agent1", "agent2"], isLoop: true },
      });

      expect(getNextInChain(session, "agent2")).toBe("agent1");
    });

    it("should return null for non chain-of-thought mode", () => {
      const session = makeSession({ mode: "war-room" });

      expect(getNextInChain(session, "agent1")).toBeNull();
    });

    it("should start from beginning when agent not in chain", () => {
      const session = makeSession({
        mode: "chain-of-thought",
        config: { chainOrder: ["agent1", "agent2"] },
      });

      expect(getNextInChain(session, "unknown")).toBe("agent1");
    });
  });

  describe("checkConsensus", () => {
    it("should detect consensus reached with threshold", () => {
      const votes = new Map([
        ["agent1", "approve"],
        ["agent2", "approve"],
        ["agent3", "reject"],
      ]);

      const result = checkConsensus(votes, 0.5, false);

      expect(result.reached).toBe(true);
      expect(result.result).toBe("approve");
    });

    it("should detect consensus not reached below threshold", () => {
      const votes = new Map([
        ["agent1", "approve"],
        ["agent2", "reject"],
        ["agent3", "abstain"],
      ]);

      const result = checkConsensus(votes, 0.5, false);

      expect(result.reached).toBe(false);
    });

    it("should require unanimous when flag is set", () => {
      const votes = new Map([
        ["agent1", "approve"],
        ["agent2", "approve"],
        ["agent3", "reject"],
      ]);

      const result = checkConsensus(votes, 0.5, true);

      expect(result.reached).toBe(false);
    });

    it("should detect unanimous consensus", () => {
      const votes = new Map([
        ["agent1", "approve"],
        ["agent2", "approve"],
      ]);

      const result = checkConsensus(votes, 0.5, true);

      expect(result.reached).toBe(true);
      expect(result.result).toBe("approve");
    });

    it("should return not reached for empty votes", () => {
      const result = checkConsensus(new Map(), 0.5, false);

      expect(result.reached).toBe(false);
    });
  });

  describe("aggregateResponses", () => {
    const responses: AgentResponse[] = [
      { agentId: "agent1", content: "Response A", timestamp: 1000 },
      { agentId: "agent2", content: "Response B", timestamp: 2000 },
    ];

    it("should concatenate responses in concat mode", () => {
      const result = aggregateResponses(responses, "concat");

      expect(result).toContain("**agent1:** Response A");
      expect(result).toContain("**agent2:** Response B");
    });

    it("should find most common response in vote mode", () => {
      const votedResponses: AgentResponse[] = [
        { agentId: "agent1", content: "yes", timestamp: 0 },
        { agentId: "agent2", content: "yes", timestamp: 0 },
        { agentId: "agent3", content: "no", timestamp: 0 },
      ];

      const result = aggregateResponses(votedResponses, "vote");

      expect(result).toBe("yes");
    });

    it("should deduplicate in summarize mode", () => {
      const dupeResponses: AgentResponse[] = [
        { agentId: "agent1", content: "Same thing", timestamp: 0 },
        { agentId: "agent2", content: "Same thing", timestamp: 0 },
        { agentId: "agent3", content: "Different", timestamp: 0 },
      ];

      const result = aggregateResponses(dupeResponses, "summarize");

      expect(result).toContain("Same thing");
      expect(result).toContain("Different");
      // Should only contain "Same thing" once
      expect(result.indexOf("Same thing")).toBe(result.lastIndexOf("Same thing"));
    });

    it("should return empty for no responses", () => {
      expect(aggregateResponses([], "concat")).toBe("");
    });
  });
});
