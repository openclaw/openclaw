import { describe, it, expect, vi } from "vitest";
import type { AgentRepository } from "../../repository/agent-repository.ts";
import type { DetectionRepository } from "../../repository/detection-repository.ts";
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

// Mock detection repo — defaults to no prior detection (null)
// insertDetection returns a StoredDetection with auto-incrementing id
let nextDetectionId = 100;
const createMockDetectionRepo = (
  lastDetection: { window_message_ids: number[] } | null = null,
): DetectionRepository => ({
  insertDetection: vi.fn().mockImplementation((params) => ({
    id: nextDetectionId++,
    conversation_id: params.conversationId,
    detection_type: params.detectionType,
    window_message_ids: params.windowMessageIds,
    created: false,
    created_at: Date.now(),
  })),
  getLastDetection: vi.fn().mockReturnValue(
    lastDetection
      ? {
          id: 1,
          conversation_id: "chat-1",
          detection_type: "add_calendar_event",
          window_message_ids: lastDetection.window_message_ids,
          created: false,
          created_at: Date.now(),
        }
      : null,
  ),
  markCreated: vi.fn(),
  deleteDetection: vi.fn(),
});

// Helper to create messages with specific IDs (for dedup tests)
const messagesWithIds = (ids: number[]): StoredMessage[] =>
  ids.map((id) => ({ ...sampleMessages[0], id }));

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
  overrides?: {
    repo?: MessageRepository;
    agentRepo?: AgentRepository;
    detectionRepo?: DetectionRepository;
  },
) => ({
  messageRepo: overrides?.repo ?? createMockRepo(),
  ollama,
  agentRepo: overrides?.agentRepo ?? createMockAgentRepo(),
  detectionRepo: overrides?.detectionRepo ?? createMockDetectionRepo(),
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

  describe("consensus detection", () => {
    it("returns add_calendar_event when both agents return T+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("add_calendar_event");
      expect(result.agentNotified).toBe(true);
      expect(result.deduped).toBe(false);
    });

    it("returns confirm_with_customer when A is T+T and B is T+F", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, TF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is T+F and B is T+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TF, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is T+T and B is F+F", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, FF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is F+F and B is T+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(FF, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns confirm_with_customer when A is T+T and B is F+T", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, FT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("confirm_with_customer");
      expect(result.agentNotified).toBe(true);
    });

    it("returns none when both agents return T+F (no date)", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TF, TF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("none");
      expect(result.agentNotified).toBe(false);
      expect(result.deduped).toBe(false);
    });

    it("returns none when neither agent detects a meeting", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(FF, FF)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("none");
      expect(result.agentNotified).toBe(false);
      expect(result.deduped).toBe(false);
    });

    it("returns none when agent A returns null (error = do nothing)", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(null, TT)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("none");
      expect(result.agentNotified).toBe(false);
    });

    it("returns none when agent B returns null (error = do nothing)", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(TT, null)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("none");
      expect(result.agentNotified).toBe(false);
    });

    it("returns none when both agents return null", async () => {
      const execute = meetingDetector(createDeps(createMockOllama(null, null)));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("none");
      expect(result.agentNotified).toBe(false);
    });
  });

  describe("agent notification", () => {
    it("calendar event prompt contains calendar-guard, calendar event, and detection ID", async () => {
      const agentRepo = createMockAgentRepo();
      const detectionRepo = createMockDetectionRepo(null);
      const execute = meetingDetector(
        createDeps(createMockOllama(TT, TT), { agentRepo, detectionRepo }),
      );
      await execute({ conversationId: "chat-1" });

      const prompt = (agentRepo.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const insertedId = (detectionRepo.insertDetection as ReturnType<typeof vi.fn>).mock.results[0]
        .value.id;
      expect(prompt).toContain("calendar-guard");
      expect(prompt).toContain("calendar event");
      expect(prompt).toContain(`Detection ID: ${insertedId}`);
    });

    it("confirmation prompt contains confirm, model reasons, and detection ID", async () => {
      const agentRepo = createMockAgentRepo();
      const detectionRepo = createMockDetectionRepo(null);
      const execute = meetingDetector(
        createDeps(createMockOllama(TT, FF), { agentRepo, detectionRepo }),
      );
      await execute({ conversationId: "chat-1" });

      const prompt = (agentRepo.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const insertedId = (detectionRepo.insertDetection as ReturnType<typeof vi.fn>).mock.results[0]
        .value.id;
      expect(prompt).toContain("confirm");
      expect(prompt).toContain(TT.reason);
      expect(prompt).toContain(`Detection ID: ${insertedId}`);
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

    it("does not call agentRepo.send when detection is none", async () => {
      const agentRepo = createMockAgentRepo();
      const execute = meetingDetector(createDeps(createMockOllama(FF, FF), { agentRepo }));
      await execute({ conversationId: "chat-1" });

      expect(agentRepo.send).not.toHaveBeenCalled();
    });

    it("returns agentNotified: false when agent send fails", async () => {
      const agentRepo = createMockAgentRepo(false);
      const execute = meetingDetector(createDeps(createMockOllama(TT, TT), { agentRepo }));
      const result = await execute({ conversationId: "chat-1" });

      expect(result.detection).toBe("add_calendar_event");
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

  describe("deduplication", () => {
    it("first detection proceeds normally when no prior detection exists", async () => {
      const agentRepo = createMockAgentRepo();
      const detectionRepo = createMockDetectionRepo(null);
      const execute = meetingDetector(
        createDeps(createMockOllama(TT, TT), { agentRepo, detectionRepo }),
      );
      const result = await execute({ conversationId: "chat-1" });

      expect(agentRepo.send).toHaveBeenCalled();
      expect(detectionRepo.insertDetection).toHaveBeenCalledWith({
        conversationId: "chat-1",
        detectionType: "add_calendar_event",
        windowMessageIds: [1, 2],
      });
      expect(result.deduped).toBe(false);
    });

    it("skips when current window overlaps with last detection", async () => {
      const agentRepo = createMockAgentRepo();
      const ollama = createMockOllama(TT, TT);
      // Last detection used IDs [1, 2] — same as sampleMessages
      const detectionRepo = createMockDetectionRepo({ window_message_ids: [1, 2] });
      const execute = meetingDetector(createDeps(ollama, { agentRepo, detectionRepo }));
      const result = await execute({ conversationId: "chat-1" });

      expect(agentRepo.send).not.toHaveBeenCalled();
      expect(ollama.generate).not.toHaveBeenCalled();
      expect(result.deduped).toBe(true);
    });

    it("skips when even 1 message ID overlaps (partial overlap)", async () => {
      const repo = createMockRepo(messagesWithIds([3, 4, 5]));
      const agentRepo = createMockAgentRepo();
      const ollama = createMockOllama(TT, TT);
      // Stored [1,2,3] — current [3,4,5] — overlap on ID 3
      const detectionRepo = createMockDetectionRepo({ window_message_ids: [1, 2, 3] });
      const execute = meetingDetector(createDeps(ollama, { repo, agentRepo, detectionRepo }));
      const result = await execute({ conversationId: "chat-1" });

      expect(agentRepo.send).not.toHaveBeenCalled();
      expect(result.deduped).toBe(true);
    });

    it("proceeds when no IDs overlap (window scrolled past)", async () => {
      const repo = createMockRepo(messagesWithIds([4, 5, 6]));
      const agentRepo = createMockAgentRepo();
      // Stored [1,2,3] — current [4,5,6] — no overlap
      const detectionRepo = createMockDetectionRepo({ window_message_ids: [1, 2, 3] });
      const execute = meetingDetector(
        createDeps(createMockOllama(TT, TT), { repo, agentRepo, detectionRepo }),
      );
      const result = await execute({ conversationId: "chat-1" });

      expect(agentRepo.send).toHaveBeenCalled();
      expect(result.deduped).toBe(false);
    });

    it("deletes detection when agent send fails (rollback)", async () => {
      const agentRepo = createMockAgentRepo(false);
      const detectionRepo = createMockDetectionRepo(null);
      const execute = meetingDetector(
        createDeps(createMockOllama(TT, TT), { agentRepo, detectionRepo }),
      );
      await execute({ conversationId: "chat-1" });

      // Insert was called (before send), then delete was called (rollback)
      expect(detectionRepo.insertDetection).toHaveBeenCalled();
      const insertedId = (detectionRepo.insertDetection as ReturnType<typeof vi.fn>).mock.results[0]
        .value.id;
      expect(detectionRepo.deleteDetection).toHaveBeenCalledWith(insertedId);
    });

    it("does not delete detection when agent send succeeds", async () => {
      const agentRepo = createMockAgentRepo(true);
      const detectionRepo = createMockDetectionRepo(null);
      const execute = meetingDetector(
        createDeps(createMockOllama(TT, TT), { agentRepo, detectionRepo }),
      );
      await execute({ conversationId: "chat-1" });

      expect(detectionRepo.insertDetection).toHaveBeenCalled();
      expect(detectionRepo.deleteDetection).not.toHaveBeenCalled();
    });

    it("does not insert detection when no meeting detected", async () => {
      const detectionRepo = createMockDetectionRepo(null);
      const execute = meetingDetector(createDeps(createMockOllama(FF, FF), { detectionRepo }));
      await execute({ conversationId: "chat-1" });

      expect(detectionRepo.insertDetection).not.toHaveBeenCalled();
    });

    it("dedup check runs before Ollama — overlapping window skips LLM calls", async () => {
      const ollama = createMockOllama(TT, TT);
      const detectionRepo = createMockDetectionRepo({ window_message_ids: [1, 2] });
      const execute = meetingDetector(createDeps(ollama, { detectionRepo }));
      await execute({ conversationId: "chat-1" });

      expect(ollama.generate).not.toHaveBeenCalled();
    });
  });
});
