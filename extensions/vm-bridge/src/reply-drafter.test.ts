import { describe, expect, it, vi } from "vitest";
import { draftReply } from "./reply-drafter.js";
import type { BridgeClient } from "./bridge-client.js";
import type { Contract, Db } from "./db.js";

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 42,
    state: "DONE",
    intent: "Update Schaumburg Sunday hours to 8-5",
    qa_doc: "Verify Sunday hours show 8-5",
    owner: "claude-dev",
    project_id: "vvg-gbp",
    claimed_by: "claude-dev",
    system_ref: {},
    message_id: "msg-outlook-42",
    message_platform: "outlook",
    message_account: null,
    sender_email: "jennifer@vvgtruck.com",
    sender_name: "Jennifer Holt",
    attachment_ids: [],
    attempt_count: 1,
    max_attempts: 3,
    qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    execution_log: "Attempt 1: Executed — updated hours",
    reply_sent: false,
    reply_draft_id: null,
    reply_content: null,
    checkpoint1_msg_id: "cp1",
    checkpoint2_msg_id: null,
    created_at: new Date(),
    claimed_at: new Date(),
    completed_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function createMockBridge() {
  return {
    createReplyDraft: vi.fn(async () => ({
      success: true,
      result: { draft_id: "draft-abc" },
    })),
    addAttachmentToDraft: vi.fn(async () => ({
      success: true,
      result: {},
    })),
    rolesList: vi.fn(async () => ({
      success: true,
      result: {},
    })),
    mcpCall: vi.fn(async () => ({ success: true })),
  } as unknown as BridgeClient;
}

function createMockDb() {
  return {
    getContactByEmail: vi.fn(async () => null),
  } as unknown as Db;
}

describe("reply drafter: screenshot attachment", () => {
  it("attaches screenshot to Outlook reply draft when screenshot_path exists", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const contract = makeContract({
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    const result = await draftReply(contract, db, bridge);

    expect(result).not.toBeNull();
    expect(result!.draftId).toBe("draft-abc");

    // addAttachmentToDraft should be called with correct args
    expect(bridge.addAttachmentToDraft).toHaveBeenCalledWith(
      "draft-abc",
      "/tmp/cos-qa-42.png",
      "xcellerate",
    );
  });

  it("skips attachment when no screenshot_path in qa_results", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const contract = makeContract({
      qa_results: { passed: true },
    });

    const result = await draftReply(contract, db, bridge);

    expect(result).not.toBeNull();
    expect(result!.draftId).toBe("draft-abc");
    expect(bridge.addAttachmentToDraft).not.toHaveBeenCalled();
  });

  it("attachment failure is non-fatal — draft still returned", async () => {
    const bridge = createMockBridge();
    (bridge.addAttachmentToDraft as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("File not found"),
    );
    const db = createMockDb();
    const contract = makeContract({
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    const result = await draftReply(contract, db, bridge);

    expect(result).not.toBeNull();
    expect(result!.draftId).toBe("draft-abc");
    expect(result!.replyContent).toBeTruthy();
  });

  it("uses message_account for attachment (falls back to xcellerate)", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const contract = makeContract({
      message_account: null,
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    await draftReply(contract, db, bridge);

    const attachCall = (bridge.addAttachmentToDraft as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(attachCall[2]).toBe("xcellerate"); // fallback account
  });

  it("skips attachment for Zoom contracts (synthetic draft)", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const contract = makeContract({
      message_platform: "zoom",
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    const result = await draftReply(contract, db, bridge);

    expect(result).not.toBeNull();
    expect(result!.draftId).toMatch(/^zoom:/);
    expect(bridge.addAttachmentToDraft).not.toHaveBeenCalled();
  });
});

describe("reply drafter: screenshot guarantee warnings", () => {
  it("logs warning when DONE contract has no screenshot_path", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const contract = makeContract({
      state: "DONE",
      qa_results: { passed: true },  // no screenshot_path
    });

    await draftReply(contract, db, bridge, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("screenshot"),
    );
  });

  it("does NOT warn when screenshot_path is present", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const contract = makeContract({
      state: "DONE",
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    await draftReply(contract, db, bridge, logger);

    // No screenshot warning (may have other logs)
    const screenshotWarnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .filter((args: unknown[]) => typeof args[0] === "string" && args[0].includes("screenshot"));
    expect(screenshotWarnings).toHaveLength(0);
  });

  it("logs warning when addAttachmentToDraft fails", async () => {
    const bridge = createMockBridge();
    (bridge.addAttachmentToDraft as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("File not found"),
    );
    const db = createMockDb();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const contract = makeContract({
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    const result = await draftReply(contract, db, bridge, logger);

    // Draft still returned (non-fatal)
    expect(result).not.toBeNull();
    expect(result!.draftId).toBe("draft-abc");

    // But a warning was logged about the attachment failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("attach"),
    );
  });
});

describe("reply drafter: account-aware replies", () => {
  it("uses contract.message_account for createReplyDraft", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const contract = makeContract({
      message_account: "vvg",
      message_platform: "outlook",
      qa_results: { passed: true },
    });

    await draftReply(contract, db, bridge);

    const draftCall = (bridge.createReplyDraft as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(draftCall[2]).toBe("vvg"); // account parameter (3rd arg)
  });

  it("uses contract.message_account for addAttachmentToDraft", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const contract = makeContract({
      message_account: "vvg",
      message_platform: "outlook",
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    await draftReply(contract, db, bridge);

    const attachCall = (bridge.addAttachmentToDraft as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(attachCall[2]).toBe("vvg"); // account parameter (3rd arg)
  });

  it("falls back to 'xcellerate' when message_account is null", async () => {
    const bridge = createMockBridge();
    const db = createMockDb();
    const contract = makeContract({
      message_account: null,
      message_platform: "outlook",
      qa_results: { passed: true, screenshot_path: "/tmp/cos-qa-42.png" },
    });

    await draftReply(contract, db, bridge);

    const draftCall = (bridge.createReplyDraft as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(draftCall[2]).toBe("xcellerate");

    const attachCall = (bridge.addAttachmentToDraft as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(attachCall[2]).toBe("xcellerate");
  });
});
