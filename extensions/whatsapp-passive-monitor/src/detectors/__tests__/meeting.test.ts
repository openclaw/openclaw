import { describe, it, expect, vi } from "vitest";
import type { AgentRepository } from "../../repository/agent-repository.ts";
import type { MessageRepository } from "../../repository/message-repository.ts";
import type { OllamaRepository } from "../../repository/ollama-repository.ts";
import type { Logger, MeetingClassification, StoredMessage } from "../../types.ts";
import { meetingDetector, type MeetingDetectorDeps } from "../meeting.ts";

const sampleMessages: StoredMessage[] = [
  {
    id: 1,
    conversation_id: "chat-1",
    sender: "+44700000001",
    sender_name: "Alice",
    content: "Hey are you free Saturday?",
    timestamp: 1700000000000,
    direction: "inbound",
    channel_id: "whatsapp",
  },
  {
    id: 2,
    conversation_id: "chat-1",
    sender: "me",
    sender_name: null,
    content: "Sure, 2pm works",
    timestamp: 1700000060000,
    direction: "outbound",
    channel_id: "whatsapp",
  },
];

const createMockRepo = (messages: StoredMessage[] = sampleMessages): MessageRepository => ({
  insertMessage: vi.fn(),
  getConversation: vi.fn().mockReturnValue(messages),
});

const createMockOllama = (result: unknown = null): OllamaRepository => ({
  generate: vi.fn().mockResolvedValue(result),
});

const createMockAgentRepo = (success = true): AgentRepository => ({
  send: vi.fn().mockResolvedValue({ success, error: success ? undefined : "agent error" }),
});

const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

// Helper: create agents array with two mock ollama instances and prompt builders
const createMockAgents = (
  resultA: MeetingClassification | null,
  resultB: MeetingClassification | null,
): MeetingDetectorDeps["agents"] => [
  {
    name: "A",
    ollama: createMockOllama(resultA),
    buildPrompt: (conversation: string) => `Agent A prompt\n--- Conversation ---\n${conversation}`,
  },
  {
    name: "B",
    ollama: createMockOllama(resultB),
    buildPrompt: (conversation: string) => `Agent B prompt\n--- Conversation ---\n${conversation}`,
  },
];

// Shorthand for classification results
const TT: MeetingClassification = {
  has_agreed_to_meet: true,
  has_agreed_date: true,
  reason: "both agreed on Saturday",
};
const TF: MeetingClassification = {
  has_agreed_to_meet: true,
  has_agreed_date: false,
  reason: "agreed to meet, no date",
};
const FT: MeetingClassification = {
  has_agreed_to_meet: false,
  has_agreed_date: true,
  reason: "no meeting, date mentioned",
};
const FF: MeetingClassification = {
  has_agreed_to_meet: false,
  has_agreed_date: false,
  reason: "no meeting",
};

describe("meetingDetector", () => {
  // --- Message repository ---

  it("queries the message repository with conversationId and limit 20", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    expect(repo.getConversation).toHaveBeenCalledWith("chat-1", { limit: 20 });
  });

  // --- Ollama prompt content ---

  it("embeds formatted conversation in both agent prompts", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    // Both agents should have received prompts with the conversation
    for (const agent of agents) {
      const call = (agent.ollama.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.prompt).toContain("Alice: Hey are you free Saturday?");
      expect(call.prompt).toContain("You: Sure, 2pm works");
    }
  });

  it("sends structured output format to Ollama with new classification schema", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    const call = (agents[0].ollama.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.format).toEqual({
      type: "object",
      properties: {
        has_agreed_to_meet: { type: "boolean" },
        has_agreed_date: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["has_agreed_to_meet", "has_agreed_date", "reason"],
    });
  });

  it("each agent prompt contains classification rules", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    // Both agents should have been called with prompts from their buildPrompt
    for (const agent of agents) {
      const call = (agent.ollama.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.prompt).toContain("--- Conversation ---");
    }
  });

  // --- Consensus escalation ---

  it("returns add_calendar_event when both agents return T+T", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, TT);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("add_calendar_event");
    expect(result.agentNotified).toBe(true);
  });

  it("returns confirm_with_customer when A is T+T and B is T+F", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, TF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("confirm_with_customer");
    expect(result.agentNotified).toBe(true);
  });

  it("returns confirm_with_customer when A is T+F and B is T+T", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TF, TT);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("confirm_with_customer");
    expect(result.agentNotified).toBe(true);
  });

  it("returns confirm_with_customer when A is T+T and B is F+F", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("confirm_with_customer");
    expect(result.agentNotified).toBe(true);
  });

  it("returns confirm_with_customer when A is F+F and B is T+T", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, TT);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("confirm_with_customer");
    expect(result.agentNotified).toBe(true);
  });

  it("returns confirm_with_customer when A is T+T and B is F+T", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, FT);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("confirm_with_customer");
    expect(result.agentNotified).toBe(true);
  });

  it("returns none when both agents return T+F (no date)", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TF, TF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("none");
    expect(result.agentNotified).toBe(false);
  });

  it("returns none when neither agent detects a meeting", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("none");
    expect(result.agentNotified).toBe(false);
  });

  it("returns none when agent A returns null (error = do nothing)", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(null, TT);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("none");
    expect(result.agentNotified).toBe(false);
  });

  it("returns none when agent B returns null (error = do nothing)", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, null);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("none");
    expect(result.agentNotified).toBe(false);
  });

  it("returns none when both agents return null", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(null, null);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("none");
    expect(result.agentNotified).toBe(false);
  });

  // --- Agent prompt content ---

  it("calendar event prompt contains calendar-guard and calendar event", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, TT);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    const prompt = (agentRepo.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("calendar-guard");
    expect(prompt).toContain("calendar event");
  });

  it("confirmation prompt contains confirm and includes model reasons", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    const prompt = (agentRepo.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("confirm");
    expect(prompt).toContain(TT.reason);
  });

  it("confirmation prompt includes reasons from the agreeing model", async () => {
    const agreeResult: MeetingClassification = {
      has_agreed_to_meet: true,
      has_agreed_date: true,
      reason: "they agreed to meet for dinner on Friday",
    };
    const repo = createMockRepo();
    const agents = createMockAgents(agreeResult, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    const prompt = (agentRepo.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("they agreed to meet for dinner on Friday");
  });

  // --- Sequential execution ---

  it("agents are called in order (A before B)", async () => {
    const repo = createMockRepo();
    const callOrder: string[] = [];
    const agents: MeetingDetectorDeps["agents"] = [
      {
        name: "A",
        ollama: {
          generate: vi.fn().mockImplementation(async () => {
            callOrder.push("A");
            return FF;
          }),
        },
        buildPrompt: (c: string) => `A\n${c}`,
      },
      {
        name: "B",
        ollama: {
          generate: vi.fn().mockImplementation(async () => {
            callOrder.push("B");
            return FF;
          }),
        },
        buildPrompt: (c: string) => `B\n${c}`,
      },
    ];
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    expect(callOrder).toEqual(["A", "B"]);
  });

  it("both agents receive the same formatted conversation", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    const promptA = (agents[0].ollama.generate as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
    const promptB = (agents[1].ollama.generate as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;

    // Both should contain the same conversation content
    expect(promptA).toContain("Alice: Hey are you free Saturday?");
    expect(promptB).toContain("Alice: Hey are you free Saturday?");
    expect(promptA).toContain("You: Sure, 2pm works");
    expect(promptB).toContain("You: Sure, 2pm works");
  });

  // --- Agent notification ---

  it("does not call agentRepo.send when escalation is none", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(FF, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    await execute({ conversationId: "chat-1" });

    expect(agentRepo.send).not.toHaveBeenCalled();
  });

  it("returns agentNotified: false when agent send fails", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, TT);
    const agentRepo = createMockAgentRepo(false);
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.escalation).toBe("add_calendar_event");
    expect(result.agentNotified).toBe(false);
  });

  // --- Result shape ---

  it("returns classifications array with results from both agents", async () => {
    const repo = createMockRepo();
    const agents = createMockAgents(TT, FF);
    const agentRepo = createMockAgentRepo();
    const logger = createMockLogger();

    const execute = meetingDetector({ messageRepo: repo, agents, agentRepo, logger });
    const result = await execute({ conversationId: "chat-1" });

    expect(result.classifications).toEqual([TT, FF]);
  });
});
