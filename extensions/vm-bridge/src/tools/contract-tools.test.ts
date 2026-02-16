import { describe, expect, it, vi, beforeEach } from "vitest";
import { createContractPollTool } from "./contract-poll.js";
import { createContractClaimTool } from "./contract-claim.js";
import { createContractReadTool } from "./contract-read.js";
import { createContractUpdateTool } from "./contract-update.js";
import type { Contract, Db } from "../db.js";

// --- Helpers ---

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 1,
    state: "PLANNING",
    intent: "Update business hours",
    qa_doc: "Verify hours changed on website",
    owner: "claude-dev",
    project_id: "vvg-gbp",
    claimed_by: null,
    system_ref: { vm: "claude-dev", chrome_profile: "vvg" },
    message_id: "msg-123",
    message_platform: "outlook",
    message_account: null,
    sender_email: "client@example.com",
    sender_name: "Client",
    attachment_ids: ["att-1"],
    attempt_count: 0,
    max_attempts: 3,
    qa_results: null,
    execution_log: null,
    reply_sent: false,
    reply_draft_id: null,
    reply_content: null,
    checkpoint1_msg_id: null,
    checkpoint2_msg_id: null,
    created_at: new Date("2026-02-14T10:00:00Z"),
    claimed_at: null,
    completed_at: null,
    updated_at: new Date("2026-02-14T10:00:00Z"),
    ...overrides,
  };
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function createMockDb(overrides: Partial<Db> = {}): Db {
  return {
    pollContracts: vi.fn(async () => []),
    claimContract: vi.fn(async () => null),
    getContract: vi.fn(async () => null),
    updateContract: vi.fn(async () => null),
    ...overrides,
  } as unknown as Db;
}

function createMockBridge() {
  return {
    readAttachment: vi.fn(async () => ({ success: true, result: { content: "file data" } })),
  } as any;
}

// --- Tests ---

describe("contract_poll tool", () => {
  it("returns empty list when no contracts available", async () => {
    const db = createMockDb({ pollContracts: vi.fn(async () => []) });
    const tool = createContractPollTool(db);

    expect(tool.name).toBe("contract_poll");

    const result = await tool.execute("call-1", { owner: "claude-dev" });
    const data = parseResult(result);

    expect(data.count).toBe(0);
    expect(data.contracts).toEqual([]);
    expect(db.pollContracts).toHaveBeenCalledWith("claude-dev");
  });

  it("returns available contracts", async () => {
    const contracts = [makeContract({ id: 1 }), makeContract({ id: 2, intent: "Fix typo" })];
    const db = createMockDb({ pollContracts: vi.fn(async () => contracts) });
    const tool = createContractPollTool(db);

    const result = await tool.execute("call-1", { owner: "claude-dev" });
    const data = parseResult(result);

    expect(data.count).toBe(2);
    expect(data.contracts[0].id).toBe(1);
    expect(data.contracts[1].intent).toBe("Fix typo");
  });

  it("returns error when owner is missing", async () => {
    const db = createMockDb();
    const tool = createContractPollTool(db);

    const result = await tool.execute("call-1", {});
    const data = parseResult(result);

    expect(data.error).toBe("owner is required");
  });
});

describe("contract_claim tool", () => {
  it("claims a contract successfully", async () => {
    const claimed = makeContract({ claimed_by: "vm-1", state: "IMPLEMENTING", claimed_at: new Date() });
    const db = createMockDb({ claimContract: vi.fn(async () => claimed) });
    const tool = createContractClaimTool(db);

    expect(tool.name).toBe("contract_claim");

    const result = await tool.execute("call-1", { contract_id: 1, claimed_by: "vm-1" });
    const data = parseResult(result);

    expect(data.claimed).toBe(true);
    expect(data.contract.state).toBe("IMPLEMENTING");
    expect(data.contract.claimed_by).toBe("vm-1");
    expect(db.claimContract).toHaveBeenCalledWith(1, "vm-1");
  });

  it("returns error when claim fails (already claimed)", async () => {
    const db = createMockDb({ claimContract: vi.fn(async () => null) });
    const tool = createContractClaimTool(db);

    const result = await tool.execute("call-1", { contract_id: 1, claimed_by: "vm-1" });
    const data = parseResult(result);

    expect(data.error).toContain("Claim failed");
    expect(data.contract_id).toBe(1);
  });

  it("returns error when required params are missing", async () => {
    const db = createMockDb();
    const tool = createContractClaimTool(db);

    const result = await tool.execute("call-1", {});
    const data = parseResult(result);

    expect(data.error).toBe("contract_id and claimed_by are required");
  });
});

describe("contract_read tool", () => {
  it("reads a contract without attachments", async () => {
    const contract = makeContract();
    const db = createMockDb({ getContract: vi.fn(async () => contract) });
    const bridge = createMockBridge();
    const tool = createContractReadTool(db, bridge);

    expect(tool.name).toBe("contract_read");

    const result = await tool.execute("call-1", { contract_id: 1 });
    const data = parseResult(result);

    expect(data.id).toBe(1);
    expect(data.intent).toBe("Update business hours");
    expect(data.qa_doc).toBe("Verify hours changed on website");
    expect(data.system_ref).toEqual({ vm: "claude-dev", chrome_profile: "vvg" });
    expect(data.attachments).toBeUndefined();
  });

  it("reads a contract with attachments when requested", async () => {
    const contract = makeContract({ attachment_ids: ["att-1", "att-2"] });
    const db = createMockDb({ getContract: vi.fn(async () => contract) });
    const bridge = createMockBridge();
    const tool = createContractReadTool(db, bridge);

    const result = await tool.execute("call-1", { contract_id: 1, include_attachments: true });
    const data = parseResult(result);

    expect(data.attachments).toHaveLength(2);
    expect(bridge.readAttachment).toHaveBeenCalledTimes(2);
    expect(bridge.readAttachment).toHaveBeenCalledWith("att-1");
    expect(bridge.readAttachment).toHaveBeenCalledWith("att-2");
  });

  it("handles attachment read failures gracefully", async () => {
    const contract = makeContract({ attachment_ids: ["att-bad"] });
    const db = createMockDb({ getContract: vi.fn(async () => contract) });
    const bridge = {
      readAttachment: vi.fn(async () => { throw new Error("not found"); }),
    } as any;
    const tool = createContractReadTool(db, bridge);

    const result = await tool.execute("call-1", { contract_id: 1, include_attachments: true });
    const data = parseResult(result);

    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0].error).toBe("Failed to read attachment");
  });

  it("returns error for missing contract", async () => {
    const db = createMockDb({ getContract: vi.fn(async () => null) });
    const bridge = createMockBridge();
    const tool = createContractReadTool(db, bridge);

    const result = await tool.execute("call-1", { contract_id: 999 });
    const data = parseResult(result);

    expect(data.error).toBe("Contract not found");
  });

  it("returns error when contract_id is missing", async () => {
    const db = createMockDb();
    const bridge = createMockBridge();
    const tool = createContractReadTool(db, bridge);

    const result = await tool.execute("call-1", {});
    const data = parseResult(result);

    expect(data.error).toBe("contract_id is required");
  });
});

describe("contract_update tool", () => {
  it("updates state to DONE with completed_at", async () => {
    const updated = makeContract({ state: "DONE", completed_at: new Date() });
    const db = createMockDb({ updateContract: vi.fn(async () => updated) });
    const tool = createContractUpdateTool(db);

    expect(tool.name).toBe("contract_update");

    const result = await tool.execute("call-1", { contract_id: 1, state: "DONE" });
    const data = parseResult(result);

    expect(data.updated).toBe(true);
    expect(data.contract.state).toBe("DONE");
    // Verify completed_at was set in the update call
    const updateCall = (db.updateContract as any).mock.calls[0];
    expect(updateCall[0]).toBe(1);
    expect(updateCall[1].state).toBe("DONE");
    expect(updateCall[1].completed_at).toBeInstanceOf(Date);
  });

  it("updates qa_results and execution_log", async () => {
    const updated = makeContract({ qa_results: { passed: true }, execution_log: "Fixed the bug" });
    const db = createMockDb({ updateContract: vi.fn(async () => updated) });
    const tool = createContractUpdateTool(db);

    const result = await tool.execute("call-1", {
      contract_id: 1,
      qa_results: { passed: true, screenshot_url: "/tmp/screenshot.png" },
      execution_log: "Fixed the bug",
    });
    const data = parseResult(result);

    expect(data.updated).toBe(true);
  });

  it("rejects invalid state values", async () => {
    const db = createMockDb();
    const tool = createContractUpdateTool(db);

    const result = await tool.execute("call-1", { contract_id: 1, state: "INVALID" });
    const data = parseResult(result);

    expect(data.error).toContain("Invalid state");
    expect(db.updateContract).not.toHaveBeenCalled();
  });

  it("rejects update with no fields", async () => {
    const db = createMockDb();
    const tool = createContractUpdateTool(db);

    const result = await tool.execute("call-1", { contract_id: 1 });
    const data = parseResult(result);

    expect(data.error).toBe("No updates provided");
  });

  it("returns error for missing contract", async () => {
    const db = createMockDb({ updateContract: vi.fn(async () => null) });
    const tool = createContractUpdateTool(db);

    const result = await tool.execute("call-1", { contract_id: 999, state: "STUCK" });
    const data = parseResult(result);

    expect(data.error).toBe("Contract not found");
  });
});
