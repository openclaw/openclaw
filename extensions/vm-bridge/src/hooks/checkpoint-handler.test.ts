import { describe, expect, it, vi, beforeEach } from "vitest";
import { createCheckpointHandler } from "./checkpoint-handler.js";
import type { Contract, Db } from "../db.js";
import type { BridgeClient } from "../bridge-client.js";
import type { VmBridgeConfig } from "../config.js";

// --- Helpers ---

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 42,
    state: "RAW",
    intent: "Update business hours",
    qa_doc: "Verify hours changed",
    owner: "claude-dev",
    project_id: "vvg-gbp",
    claimed_by: null,
    system_ref: {},
    message_id: "msg-123",
    message_platform: "outlook",
    message_account: null,
    sender_email: "client@example.com",
    sender_name: "Client",
    attachment_ids: [],
    attempt_count: 0,
    max_attempts: 3,
    qa_results: null,
    execution_log: null,
    reply_sent: false,
    reply_draft_id: null,
    reply_content: null,
    checkpoint1_msg_id: "cp1-msg",
    checkpoint2_msg_id: null,
    created_at: new Date(),
    claimed_at: null,
    completed_at: null,
    updated_at: new Date(),
    ...overrides,
  };
}

const SELF_EMAIL = "mike@xcellerateeq.ai";

const CONFIG: VmBridgeConfig = {
  database: { host: "localhost", port: 5433, user: "postgres", password: "test", database: "test" },
  polling: { intervalMs: 60000, accounts: ["xcellerate"], zoomEnabled: true, emailDaysBack: 1, maxEmailsPerRun: 20 },
  bridge: { url: "http://localhost:8585", healthCheckMs: 30000 },
  classifier: { provider: "openai", model: "gpt-4o-mini" },
  checkpoints: { selfEmail: SELF_EMAIL, selfAccount: "xcellerate", replyPrefix: "CONTRACT:" },
  agentLoop: { pollIntervalMs: 15000 },
  vms: {},
  projects: {},
};

function createMocks() {
  const db = {
    getContract: vi.fn(async () => null),
    updateContract: vi.fn(async () => null),
    updateContractIntent: vi.fn(async () => undefined),
  } as unknown as Db;

  const bridge = {
    messagesSend: vi.fn(async () => ({ success: true, result: { pending_id: "ps-1" } })),
    confirmSend: vi.fn(async () => ({ success: true, result: {} })),
    sendDraft: vi.fn(async () => ({ success: true, result: { pending_id: "ps-2" } })),
  } as unknown as BridgeClient;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return { db, bridge, logger };
}

// --- Tests ---

describe("checkpoint handler", () => {
  describe("message filtering", () => {
    it("ignores empty content", async () => {
      const { db, bridge, logger } = createMocks();
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "", senderEmail: SELF_EMAIL });
      await handler({ content: undefined, senderEmail: SELF_EMAIL });

      expect(db.getContract).not.toHaveBeenCalled();
    });

    it("ignores messages from other senders", async () => {
      const { db, bridge, logger } = createMocks();
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 approve", senderEmail: "other@example.com" });

      expect(db.getContract).not.toHaveBeenCalled();
    });

    it("ignores messages that don't match the CONTRACT: pattern", async () => {
      const { db, bridge, logger } = createMocks();
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "Hello there", senderEmail: SELF_EMAIL });
      await handler({ content: "CONTRACT: approve", senderEmail: SELF_EMAIL }); // no ID
      await handler({ content: "CONTRACT:abc approve", senderEmail: SELF_EMAIL }); // non-numeric

      expect(db.getContract).not.toHaveBeenCalled();
    });

    it("warns about unknown contract IDs", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(null);
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:999 approve", senderEmail: SELF_EMAIL });

      expect(db.getContract).toHaveBeenCalledWith(999);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unknown contract #999"),
      );
    });
  });

  describe("checkpoint 1 (RAW state)", () => {
    it("approves contract: RAW -> PLANNING", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(makeContract({ state: "RAW" }));
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 approve", senderEmail: SELF_EMAIL });

      expect(db.updateContract).toHaveBeenCalledWith(42, { state: "PLANNING" });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("approved -> PLANNING"));
    });

    it("rejects contract: RAW -> ABANDONED", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(makeContract({ state: "RAW" }));
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 reject", senderEmail: SELF_EMAIL });

      expect(db.updateContract).toHaveBeenCalledWith(42, { state: "ABANDONED" });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("rejected -> ABANDONED"));
    });

    it("edits contract intent and approves: RAW -> PLANNING", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(makeContract({ state: "RAW" }));
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({
        content: "CONTRACT:42 edit: Change Sunday hours to 9-4",
        senderEmail: SELF_EMAIL,
      });

      expect(db.updateContract).toHaveBeenCalledWith(42, { state: "PLANNING" });
      expect(db.updateContractIntent).toHaveBeenCalledWith(42, "Change Sunday hours to 9-4");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("edited + approved"));
    });

    it("is case-insensitive for actions", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(makeContract({ state: "RAW" }));
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 APPROVE", senderEmail: SELF_EMAIL });

      expect(db.updateContract).toHaveBeenCalledWith(42, { state: "PLANNING" });
    });
  });

  describe("checkpoint 2 (DONE state)", () => {
    it("approves Outlook reply: sends draft and marks reply_sent", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(
        makeContract({
          state: "DONE",
          reply_draft_id: "draft-outlook-123",
          reply_content: "The update has been applied.",
        }),
      );
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 approve", senderEmail: SELF_EMAIL });

      expect(bridge.sendDraft).toHaveBeenCalledWith("draft-outlook-123");
      expect(bridge.confirmSend).toHaveBeenCalledWith("ps-2");
      expect(db.updateContract).toHaveBeenCalledWith(42, { reply_sent: true });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("reply sent"));
    });

    it("revise clears draft for re-drafting on next tick", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(
        makeContract({
          state: "DONE",
          reply_draft_id: "draft-123",
          reply_content: "old draft",
          checkpoint2_msg_id: "cp2-msg",
        }),
      );
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 revise", senderEmail: SELF_EMAIL });

      expect(db.updateContract).toHaveBeenCalledWith(42, {
        reply_draft_id: null,
        reply_content: null,
        checkpoint2_msg_id: null,
      });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("revision requested"));
    });

    it("does nothing for DONE contract without reply_draft_id", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(
        makeContract({ state: "DONE", reply_draft_id: null }),
      );
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 approve", senderEmail: SELF_EMAIL });

      expect(bridge.sendDraft).not.toHaveBeenCalled();
      expect(db.updateContract).not.toHaveBeenCalled();
    });
  });

  describe("state guard", () => {
    it("does nothing for IMPLEMENTING state", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(makeContract({ state: "IMPLEMENTING" }));
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 approve", senderEmail: SELF_EMAIL });

      expect(db.updateContract).not.toHaveBeenCalled();
    });

    it("does nothing for ABANDONED state", async () => {
      const { db, bridge, logger } = createMocks();
      (db.getContract as any).mockResolvedValue(makeContract({ state: "ABANDONED" }));
      const handler = createCheckpointHandler(db, CONFIG, bridge, logger);

      await handler({ content: "CONTRACT:42 approve", senderEmail: SELF_EMAIL });

      expect(db.updateContract).not.toHaveBeenCalled();
    });
  });
});
