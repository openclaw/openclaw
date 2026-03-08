import { describe, it, expect, vi } from "vitest";
import type { AgentRepository } from "../../repository/agent-repository.ts";
import type { MessageRepository } from "../../repository/message-repository.ts";
import type { OllamaRepository } from "../../repository/ollama-repository.ts";
import type { Logger, MeetingClassification, StoredMessage } from "../../types.ts";
import { meetingDetector } from "../meeting.ts";

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

// Single mock ollama — use mockResolvedValueOnce for sequential agent calls
const createMockOllama = (
  resultA: MeetingClassification | null,
  resultB: MeetingClassification | null,
): OllamaRepository => ({
  generate: vi.fn().mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB),
});

const createMockAgentRepo = (success = true): AgentRepository => ({
  send: vi.fn().mockResolvedValue({ success, error: success ? undefined : "agent error" }),
});

const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

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

// Helper to create deps object
const createDeps = (
  ollama: OllamaRepository,
  overrides?: { repo?: MessageRepository; agentRepo?: AgentRepository },
) => ({
  messageRepo: overrides?.repo ?? createMockRepo(),
  ollama,
  agentRepo: overrides?.agentRepo ?? createMockAgentRepo(),
  logger: createMockLogger(),
});

describe("meetingDetector", () => {
  describe("message repository", () => {
    it("queries with conversationId and limit 20", async () => {
      const repo = createMockRepo();
      const ollama = createMockOllama(FF, FF);
      const deps = createDeps(ollama, { repo });

      const execute = meetingDetector(deps);
      await execute({ conversationId: "chat-1" });

      expect(repo.getConversation).toHaveBeenCalledWith("chat-1", { limit: 20 });
    });
  });

  describe("ollama classification", () => {
    it("embeds formatted conversation in both agent prompts", async () => {
      const ollama = createMockOllama(FF, FF);
      const execute = meetingDetector(createDeps(ollama));
      await execute({ conversationId: "chat-1" });

      const calls = (ollama.generate as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].prompt).toContain("Alice: Hey are you free Saturday?");
      expect(calls[0][0].prompt).toContain("You: Sure, 2pm works");
      expect(calls[1][0].prompt).toContain("Alice: Hey are you free Saturday?");
      expect(calls[1][0].prompt).toContain("You: Sure, 2pm works");
    });

    it("sends structured output format with classification schema", async () => {
      const ollama = createMockOllama(FF, FF);
      const execute = meetingDetector(createDeps(ollama));
      await execute({ conversationId: "chat-1" });

      const call = (ollama.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
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

    it("passes the correct model for each agent", async () => {
      const ollama = createMockOllama(FF, FF);
      const execute = meetingDetector(createDeps(ollama));
      await execute({ conversationId: "chat-1" });

      const calls = (ollama.generate as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].model).toBe("qwen3.5:4b");
      expect(calls[1][0].model).toBe("llama3.1:8b");
    });

    it("agent A prompt contains rule-based classification keywords", async () => {
      const ollama = createMockOllama(FF, FF);
      const execute = meetingDetector(createDeps(ollama));
      await execute({ conversationId: "chat-1" });

      const promptA = (ollama.generate as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
      expect(promptA).toContain("has_agreed_to_meet is TRUE when");
      expect(promptA).toContain("has_agreed_to_meet is FALSE when");
    });

    it("agent B prompt contains step-by-step classification keywords", async () => {
      const ollama = createMockOllama(FF, FF);
      const execute = meetingDetector(createDeps(ollama));
      await execute({ conversationId: "chat-1" });

      const promptB = (ollama.generate as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt;
      expect(promptB).toContain("STEP 1");
      expect(promptB).toContain("STEP 2");
      expect(promptB).toContain("Read the ENTIRE conversation");
    });
  });

  describe("consensus escalation", () => {
    it("returns add_calendar_event when both agents return T+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("add_calendar_event");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is T+T and B is T+F", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, TF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is T+F and B is T+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TF, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is T+T and B is F+F", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, FF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is F+F and B is T+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(FF, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is T+T and B is F+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, FT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns none when both agents return T+F (no date)", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TF, TF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("none");
      expect(result.agentNotified).toBe(false);
    });

    it("returns none when neither agent detects a meeting", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(FF, FF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("none");
      expect(result.agentNotified).toBe(false);
    });

    it("returns none when agent A returns null (error = do nothing)", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(null, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("none");
      expect(result.agentNotified).toBe(false);
    });

    it("returns none when agent B returns null (error = do nothing)", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, null)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("none");
      expect(result.agentNotified).toBe(false);
    });

    it("returns none when both agents return null", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(null, null)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("none");
      expect(result.agentNotified).toBe(false);
    });
  });

  describe("agent notification", () => {
    it("calendar event prompt contains calendar-guard and calendar event", async () => {
      const agentRepo = createMockAgentRepo();
      const execute = meetingDetector(createDeps(createMockOllama(TT, TT), { agentRepo }));
      await execute({ conversationId: "chat-1" });

      const prompt = (agentRepo.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain("calendar-guard");
      expect(prompt).toContain("calendar event");
    });

    it("confirmation prompt contains confirm and includes model reasons", async () => {
      const agentRepo = createMockAgentRepo();
      const execute = meetingDetector(createDeps(createMockOllama(TT, FF), { agentRepo }));
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
      const agentRepo = createMockAgentRepo();
      const execute = meetingDetector(createDeps(createMockOllama(agreeResult, FF), { agentRepo }));
      await execute({ conversationId: "chat-1" });

      const prompt = (agentRepo.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain("they agreed to meet for dinner on Friday");
    });

    it("does not call agentRepo.send when escalation is none", async () => {
      const agentRepo = createMockAgentRepo();
      const execute = meetingDetector(createDeps(createMockOllama(FF, FF), { agentRepo }));
      await execute({ conversationId: "chat-1" });

      expect(agentRepo.send).not.toHaveBeenCalled();
    });

    it("returns agentNotified: false when agent send fails", async () => {
      const agentRepo = createMockAgentRepo(false);
      const execute = meetingDetector(createDeps(createMockOllama(TT, TT), { agentRepo }));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.escalation).toBe("add_calendar_event");
      expect(result.agentNotified).toBe(false);
    });
  });

  describe("sequential execution", () => {
    it("agents are called in order (A before B)", async () => {
      const callOrder: string[] = [];
      const ollama: OllamaRepository = {
        generate: vi.fn().mockImplementation(async (params: { model: string }) => {
          callOrder.push(params.model);
          return FF;
        }),
      };

      const execute = meetingDetector(createDeps(ollama));
      await execute({ conversationId: "chat-1" });

      expect(callOrder).toEqual(["qwen3.5:4b", "llama3.1:8b"]);
    });

    it("both agents receive the same formatted conversation", async () => {
      const ollama = createMockOllama(FF, FF);
      const execute = meetingDetector(createDeps(ollama));
      await execute({ conversationId: "chat-1" });

      const calls = (ollama.generate as ReturnType<typeof vi.fn>).mock.calls;
      const promptA = calls[0][0].prompt;
      const promptB = calls[1][0].prompt;

      expect(promptA).toContain("Alice: Hey are you free Saturday?");
      expect(promptB).toContain("Alice: Hey are you free Saturday?");
      expect(promptA).toContain("You: Sure, 2pm works");
      expect(promptB).toContain("You: Sure, 2pm works");
    });
  });

  describe("result shape", () => {
    it("returns classifications array with results from both agents", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, FF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.classifications).toEqual([TT, FF]);
    });
  });
});
