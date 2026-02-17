import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createBridgeHealthService } from "./bridge-health.js";
import { createPollerService } from "./poller.js";
import type { Db, Contract } from "../db.js";
import type { BridgeClient } from "../bridge-client.js";
import type { VmBridgeConfig } from "../config.js";
import type { Notifier } from "../notifier.js";
// Module-level mock for draftReply — keeps it fast under fake timers
// (only used by draft retry backoff tests; other tests don't call draftReply)
vi.mock("../reply-drafter.js", () => ({
  draftReply: vi.fn(async () => null),
}));
import { draftReply as draftReplyMock } from "../reply-drafter.js";
const mockDraftReply = draftReplyMock as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

describe("bridge-health service", () => {
  it("has correct id", () => {
    const bridge = { health: vi.fn(async () => ({ ok: true })) } as unknown as BridgeClient;
    const service = createBridgeHealthService(bridge, 30_000);
    expect(service.id).toBe("vm-bridge-health");
  });

  it("runs initial health check on start", async () => {
    const bridge = { health: vi.fn(async () => ({ ok: true })) } as unknown as BridgeClient;
    const service = createBridgeHealthService(bridge, 30_000);
    const logger = makeLogger();

    await service.start({ logger });

    expect(bridge.health).toHaveBeenCalledTimes(1);
    await service.stop({ logger });
  });

  it("logs warning when bridge becomes unreachable", async () => {
    let healthy = true;
    const bridge = {
      health: vi.fn(async () => {
        if (healthy) return { ok: true };
        return { ok: false, error: "ECONNREFUSED" };
      }),
    } as unknown as BridgeClient;
    const service = createBridgeHealthService(bridge, 1000);
    const logger = makeLogger();

    await service.start({ logger });
    expect(logger.warn).not.toHaveBeenCalled();

    // Simulate bridge going down
    healthy = false;
    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Bridge server unreachable"),
    );

    await service.stop({ logger });
  });

  it("logs recovery when bridge comes back", async () => {
    let healthy = false;
    const bridge = {
      health: vi.fn(async () => {
        if (healthy) return { ok: true };
        return { ok: false, error: "down" };
      }),
    } as unknown as BridgeClient;
    const service = createBridgeHealthService(bridge, 1000);
    const logger = makeLogger();

    await service.start({ logger }); // initial check: down
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Simulate bridge recovery
    healthy = true;
    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Bridge server recovered"),
    );

    await service.stop({ logger });
  });

  it("stops cleanly", async () => {
    const bridge = { health: vi.fn(async () => ({ ok: true })) } as unknown as BridgeClient;
    const service = createBridgeHealthService(bridge, 1000);
    const logger = makeLogger();

    await service.start({ logger });
    await service.stop({ logger });

    // Advance time — no more calls should happen
    const callsBefore = (bridge.health as any).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect((bridge.health as any).mock.calls.length).toBe(callsBefore);
  });
});

describe("poller service", () => {
  const CONFIG: VmBridgeConfig = {
    database: { host: "localhost", port: 5433, user: "postgres", password: "test", database: "test" },
    polling: { intervalMs: 60_000, accounts: ["xcellerate", "vvg"], zoomEnabled: false, emailDaysBack: 1, maxEmailsPerRun: 20 },
    bridge: { url: "http://localhost:8585", healthCheckMs: 30_000 },
    classifier: { provider: "openai", model: "gpt-4o-mini" },
    checkpoints: { selfEmail: "mike@test.com", selfAccount: "xcellerate", replyPrefix: "CONTRACT:" },
    vms: {},
    projects: {},
  };

  function createMockDeps() {
    const db = {
      findRawContracts: vi.fn(async () => []),
      findCompletedContracts: vi.fn(async () => []),
      findStuckContracts: vi.fn(async () => []),
      updateContract: vi.fn(async () => null),
      getContract: vi.fn(async () => null),
      getContactByEmail: vi.fn(async () => null),
      contractExistsForMessage: vi.fn(async () => false),
    } as unknown as Db;

    const bridge = {
      messagesList: vi.fn(async () => ({ success: true, result: { messages: [] } })),
      enrichmentsGet: vi.fn(async () => ({ success: true, result: {} })),
      mcpCall: vi.fn(async () => ({ success: true })),
      createReplyDraft: vi.fn(async () => ({ success: true, result: { draft_id: "draft-1" } })),
      rolesList: vi.fn(async () => ({ success: true, result: {} })),
    } as unknown as BridgeClient;

    const notifier = {
      notifyCheckpoint1: vi.fn(async () => "cp1-msg-id"),
      notifyCheckpoint2: vi.fn(async () => "cp2-msg-id"),
      notifyStuck: vi.fn(async () => undefined),
      notifyReview: vi.fn(async () => undefined),
    } as unknown as Notifier;

    return { db, bridge, notifier };
  }

  it("has correct id", () => {
    const { db, bridge, notifier } = createMockDeps();
    const service = createPollerService(db, CONFIG, bridge, notifier);
    expect(service.id).toBe("vm-bridge-poller");
  });

  it("runs initial tick on start", async () => {
    const { db, bridge, notifier } = createMockDeps();
    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    await service.start({ logger });

    // Should have called messagesList for each polling account
    expect(bridge.messagesList).toHaveBeenCalledWith("outlook", 1, 20, "xcellerate");
    expect(bridge.messagesList).toHaveBeenCalledWith("outlook", 1, 20, "vvg");
    expect(db.findCompletedContracts).toHaveBeenCalled();
    expect(db.findStuckContracts).toHaveBeenCalled();

    await service.stop({ logger });
  });

  it("sends checkpoint 1 for raw contracts", async () => {
    const rawContract: Contract = {
      id: 10,
      state: "RAW",
      intent: "Test intent",
      qa_doc: null,
      owner: "claude-dev",
      project_id: null,
      claimed_by: null,
      system_ref: {},
      message_id: null,
      message_platform: null,
      message_account: null,
      sender_email: null,
      sender_name: null,
      attachment_ids: [],
      attempt_count: 0,
      max_attempts: 3,
      qa_results: null,
      execution_log: null,
      reply_sent: false,
      reply_draft_id: null,
      reply_content: null,
      checkpoint1_msg_id: null,
      checkpoint2_msg_id: null,
      created_at: new Date(),
      claimed_at: null,
      completed_at: null,
      updated_at: new Date(),
    };

    const { db, bridge, notifier } = createMockDeps();
    (db.findRawContracts as any).mockResolvedValue([rawContract]);
    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    await service.start({ logger });

    expect(notifier.notifyCheckpoint1).toHaveBeenCalledWith(rawContract);
    expect(db.updateContract).toHaveBeenCalledWith(10, { checkpoint1_msg_id: "cp1-msg-id" });

    await service.stop({ logger });
  });

  it("logs errors but does not crash on tick failure", async () => {
    const { db, bridge, notifier } = createMockDeps();
    (bridge.messagesList as any).mockRejectedValue(new Error("network error"));
    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    // Should not throw
    await service.start({ logger });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Email ingestion failed"),
    );

    await service.stop({ logger });
  });

  it("stops cleanly and prevents further ticks", async () => {
    const { db, bridge, notifier } = createMockDeps();
    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    await service.start({ logger });
    const callsBefore = (bridge.messagesList as any).mock.calls.length;

    await service.stop({ logger });

    // Advance time — no more calls
    await vi.advanceTimersByTimeAsync(120_000);
    expect((bridge.messagesList as any).mock.calls.length).toBe(callsBefore);
    expect(logger.info).toHaveBeenCalledWith("[vm-bridge] Poller stopped");
  });
});

// ---------------------------------------------------------------------------
// Ingestion idempotency — contract-level dedup
// ---------------------------------------------------------------------------

describe("poller: ingestion idempotency", () => {
  const CONFIG: VmBridgeConfig = {
    database: { host: "localhost", port: 5433, user: "postgres", password: "test", database: "test" },
    polling: { intervalMs: 60_000, accounts: ["xcellerate"], zoomEnabled: false, emailDaysBack: 1, maxEmailsPerRun: 20 },
    bridge: { url: "http://localhost:8585", healthCheckMs: 30_000 },
    classifier: { provider: "openai", model: "gpt-4o-mini" },
    checkpoints: { selfEmail: "mike@test.com", selfAccount: "xcellerate", replyPrefix: "CONTRACT:" },
    vms: {},
    projects: {},
  };

  function createMockDeps() {
    const db = {
      findRawContracts: vi.fn(async () => []),
      findCompletedContracts: vi.fn(async () => []),
      findStuckContracts: vi.fn(async () => []),
      updateContract: vi.fn(async () => null),
      getContract: vi.fn(async () => null),
      getContactByEmail: vi.fn(async () => null),
      contractExistsForMessage: vi.fn(async () => false),
    } as unknown as Db;

    const bridge = {
      messagesList: vi.fn(async () => ({ success: true, result: { messages: [] } })),
      enrichmentsGet: vi.fn(async () => ({ success: true, result: {} })),
      mcpCall: vi.fn(async () => ({ success: true })),
      createReplyDraft: vi.fn(async () => ({ success: true, result: { draft_id: "draft-1" } })),
      rolesList: vi.fn(async () => ({ success: true, result: {} })),
    } as unknown as BridgeClient;

    const notifier = {
      notifyCheckpoint1: vi.fn(async () => "cp1-msg-id"),
      notifyCheckpoint2: vi.fn(async () => "cp2-msg-id"),
      notifyStuck: vi.fn(async () => undefined),
      notifyReview: vi.fn(async () => undefined),
    } as unknown as Notifier;

    return { db, bridge, notifier };
  }

  it("skips message when contract already exists for that message_id", async () => {
    const { db, bridge, notifier } = createMockDeps();

    // Message returns from inbox — enrichment says NOT processed
    (bridge.messagesList as any).mockResolvedValue({
      success: true,
      result: {
        messages: [{
          platform_message_id: "msg-dup-1",
          subject: "Update hours",
          content: "Please update hours",
          sender_email: "test@example.com",
          sender_name: "Test User",
        }],
      },
    });
    (bridge.enrichmentsGet as any).mockResolvedValue({ success: true, result: {} });

    // BUT a contract already exists for this message_id
    (db.contractExistsForMessage as any) = vi.fn(async () => true);

    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    await service.start({ logger });

    // contractExistsForMessage should have been called with the message_id
    expect((db as any).contractExistsForMessage).toHaveBeenCalledWith("msg-dup-1");

    // No contract should be created (no notifyCheckpoint1 for new contracts from ingestion)
    // The only notifyCheckpoint1 calls would be from findRawContracts safety net
    expect(notifier.notifyCheckpoint1).not.toHaveBeenCalled();

    await service.stop({ logger });
  });

  it("proceeds with contract creation when no existing contract for message_id", async () => {
    const { db, bridge, notifier } = createMockDeps();

    (bridge.messagesList as any).mockResolvedValue({
      success: true,
      result: {
        messages: [{
          platform_message_id: "msg-new-1",
          subject: "Update hours",
          content: "Please update hours",
          sender_email: "test@example.com",
          sender_name: "Test User",
        }],
      },
    });
    (bridge.enrichmentsGet as any).mockResolvedValue({ success: true, result: {} });

    // No existing contract for this message_id
    (db.contractExistsForMessage as any) = vi.fn(async () => false);

    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    await service.start({ logger });

    // contractExistsForMessage should have been checked
    expect((db as any).contractExistsForMessage).toHaveBeenCalledWith("msg-new-1");

    await service.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Draft retry backoff — detectCompletions doesn't loop forever
// ---------------------------------------------------------------------------

describe("poller: draft retry backoff", () => {
  const CONFIG: VmBridgeConfig = {
    database: { host: "localhost", port: 5433, user: "postgres", password: "test", database: "test" },
    polling: { intervalMs: 60_000, accounts: ["xcellerate"], zoomEnabled: false, emailDaysBack: 1, maxEmailsPerRun: 20 },
    bridge: { url: "http://localhost:8585", healthCheckMs: 30_000 },
    classifier: { provider: "openai", model: "gpt-4o-mini" },
    checkpoints: { selfEmail: "mike@test.com", selfAccount: "xcellerate", replyPrefix: "CONTRACT:" },
    vms: {},
    projects: {},
  };

  function makeDoneContract(id: number): Contract {
    return {
      id,
      state: "DONE",
      intent: "Update hours",
      qa_doc: null,
      owner: "claude-dev",
      project_id: "vvg-gbp",
      claimed_by: "claude-dev",
      system_ref: {},
      message_id: "msg-1",
      message_platform: "outlook",
      message_account: "vvg",
      sender_email: "test@example.com",
      sender_name: "Test User",
      attachment_ids: [],
      attempt_count: 1,
      max_attempts: 3,
      qa_results: { passed: true },
      execution_log: "Done",
      reply_sent: false,
      reply_draft_id: null,
      reply_content: null,
      checkpoint1_msg_id: "cp1",
      checkpoint2_msg_id: null,
      created_at: new Date(),
      claimed_at: new Date(),
      completed_at: new Date(),
      updated_at: new Date(),
    };
  }

  function createMockDeps() {
    const db = {
      findRawContracts: vi.fn(async () => []),
      findCompletedContracts: vi.fn(async () => []),
      findStuckContracts: vi.fn(async () => []),
      updateContract: vi.fn(async () => null),
      getContract: vi.fn(async () => null),
      getContactByEmail: vi.fn(async () => null),
      contractExistsForMessage: vi.fn(async () => false),
    } as unknown as Db;

    const bridge = {
      messagesList: vi.fn(async () => ({ success: true, result: { messages: [] } })),
      enrichmentsGet: vi.fn(async () => ({ success: true, result: {} })),
      mcpCall: vi.fn(async () => ({ success: true })),
      createReplyDraft: vi.fn(async () => ({ success: true, result: { draft_id: null } })),
      addAttachmentToDraft: vi.fn(async () => ({ success: true })),
      rolesList: vi.fn(async () => ({ success: true, result: {} })),
    } as unknown as BridgeClient;

    const notifier = {
      notifyCheckpoint1: vi.fn(async () => "cp1-msg-id"),
      notifyCheckpoint2: vi.fn(async () => "cp2-msg-id"),
      notifyStuck: vi.fn(async () => undefined),
      notifyReview: vi.fn(async () => undefined),
    } as unknown as Notifier;

    return { db, bridge, notifier };
  }

  beforeEach(() => {
    mockDraftReply.mockReset();
    mockDraftReply.mockResolvedValue(null); // Default: draftReply fails
  });

  it("stops retrying draftReply after 3 consecutive failures for same contract", async () => {
    const contract = makeDoneContract(99);
    const { db, bridge, notifier } = createMockDeps();

    // Contract keeps appearing as completed; draftReply returns null (module mock)
    (db.findCompletedContracts as any).mockResolvedValue([contract]);

    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    await service.start({ logger }); // tick 1: failure 1
    await vi.advanceTimersByTimeAsync(60_000); // tick 2: failure 2
    await vi.advanceTimersByTimeAsync(60_000); // tick 3: failure 3
    await vi.advanceTimersByTimeAsync(60_000); // tick 4: should be skipped

    // After 3 failed ticks, the 4th tick should skip with a warning
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/skip|giving up|max.*draft|draft.*attempt/i),
    );

    await service.stop({ logger });
  });

  it("resets failure count on successful draft", async () => {
    const { db, bridge, notifier } = createMockDeps();

    let callCount = 0;
    (db.findCompletedContracts as any).mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return [makeDoneContract(100)];
      return [];
    });

    // First call: draftReply fails (returns null). Second call: succeeds.
    mockDraftReply
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ draftId: "draft-success", replyContent: "Done" });

    // Mock getContract to return the updated contract for checkpoint 2
    (db.getContract as any).mockImplementation(async (id: number) => {
      const c = makeDoneContract(id);
      c.reply_draft_id = "draft-success";
      c.reply_content = "Done";
      return c;
    });

    const service = createPollerService(db, CONFIG, bridge, notifier);
    const logger = makeLogger();

    await service.start({ logger }); // tick 1: failure (draftReply returns null)
    await vi.advanceTimersByTimeAsync(60_000); // tick 2: success (draftReply returns draft)

    // Checkpoint 2 should have been sent (draft succeeded on tick 2)
    expect(notifier.notifyCheckpoint2).toHaveBeenCalled();

    // No "giving up" warnings — failure count was reset by success
    const warnCalls = (logger.warn as any).mock.calls.map((c: unknown[]) => c[0] as string);
    const gaveUp = warnCalls.some((msg: string) => /skip|giving up|max.*draft/i.test(msg));
    expect(gaveUp).toBe(false);

    await service.stop({ logger });
  });
});
