import { describe, expect, it, vi } from "vitest";
import { createContract } from "./contract-factory.js";
import type { Db, Contract } from "./db.js";
import type { DispatchResult } from "./dispatcher.js";

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 1,
    state: "RAW",
    intent: "Update hours",
    qa_doc: "Verify hours",
    owner: "claude-dev",
    project_id: "vvg-gbp",
    claimed_by: null,
    system_ref: { ec2_instance_id: "claude-dev", chrome_profile: "vvg", repo_path: "/home/ubuntu/gbp" },
    message_id: "msg-1",
    message_platform: "outlook",
    message_account: null,
    sender_email: "test@example.com",
    sender_name: "Test",
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
    created_at: new Date(),
    claimed_at: null,
    completed_at: null,
    updated_at: new Date(),
    ...overrides,
  };
}

describe("createContract", () => {
  it("creates a contract with full dispatch result", async () => {
    const mockDb = {
      createContract: vi.fn(async (data: any) => makeContract(data)),
    } as unknown as Db;

    const dispatch: DispatchResult = {
      matched: true,
      project_id: "vvg-gbp",
      project: {
        id: "vvg-gbp",
        name: "VVG GBP",
        vm_owner: "vvg-gbp-ec2",
        chrome_profile: "vvg",
        repo_path: "/home/ubuntu/gbp",
        domain: "vvgtruck.com",
      },
      intent: "Update Schaumburg Sunday hours to 8-5",
      qa_doc: "Navigate to Schaumburg listing, check Sunday hours show 8:00 AM - 5:00 PM",
      confidence: 0.95,
    };

    const contract = await createContract(mockDb, {
      dispatch,
      message_id: "msg-outlook-123",
      message_platform: "outlook",
      sender_email: "jennifer@vvgtruck.com",
      sender_name: "Jennifer Holt",
      attachment_ids: ["att-1", "att-2"],
    });

    const call = (mockDb.createContract as any).mock.calls[0][0];
    expect(call.intent).toBe("Update Schaumburg Sunday hours to 8-5");
    expect(call.qa_doc).toBe("Navigate to Schaumburg listing, check Sunday hours show 8:00 AM - 5:00 PM");
    expect(call.owner).toBe("vvg-gbp-ec2");
    expect(call.project_id).toBe("vvg-gbp");
    expect(call.system_ref).toEqual({
      ec2_instance_id: "vvg-gbp-ec2",
      chrome_profile: "vvg",
      repo_path: "/home/ubuntu/gbp",
      domain: "vvgtruck.com",
    });
    expect(call.message_id).toBe("msg-outlook-123");
    expect(call.message_platform).toBe("outlook");
    expect(call.sender_email).toBe("jennifer@vvgtruck.com");
    expect(call.sender_name).toBe("Jennifer Holt");
    expect(call.attachment_ids).toEqual(["att-1", "att-2"]);
  });

  it("creates contract with 'unassigned' owner when no project", async () => {
    const mockDb = {
      createContract: vi.fn(async (data: any) => makeContract(data)),
    } as unknown as Db;

    const dispatch: DispatchResult = {
      matched: true,
      intent: "Do something",
      confidence: 0.6,
    };

    await createContract(mockDb, {
      dispatch,
      message_id: "msg-2",
      message_platform: "zoom",
      sender_email: "unknown@example.com",
    });

    const call = (mockDb.createContract as any).mock.calls[0][0];
    expect(call.owner).toBe("unassigned");
    expect(call.project_id).toBeUndefined();
    expect(call.system_ref).toEqual({});
    expect(call.attachment_ids).toEqual([]);
  });

  it("passes message_account through to db.createContract", async () => {
    const mockDb = {
      createContract: vi.fn(async (data: any) => makeContract(data)),
    } as unknown as Db;

    const dispatch: DispatchResult = {
      matched: true,
      project_id: "vvg-gbp",
      project: {
        id: "vvg-gbp",
        name: "VVG GBP",
        vm_owner: "vvg-gbp-ec2",
        chrome_profile: "vvg",
        repo_path: "/home/ubuntu/gbp",
        domain: "vvgtruck.com",
      },
      intent: "Update hours",
      confidence: 0.9,
    };

    await createContract(mockDb, {
      dispatch,
      message_id: "msg-3",
      message_platform: "outlook",
      sender_email: "roy@vvgtruck.com",
      message_account: "vvg",
    });

    const call = (mockDb.createContract as any).mock.calls[0][0];
    expect(call.message_account).toBe("vvg");
  });

  it("defaults message_account to undefined when not provided", async () => {
    const mockDb = {
      createContract: vi.fn(async (data: any) => makeContract(data)),
    } as unknown as Db;

    const dispatch: DispatchResult = {
      matched: true,
      intent: "Do something",
      confidence: 0.6,
    };

    await createContract(mockDb, {
      dispatch,
      message_id: "msg-4",
      message_platform: "zoom",
      sender_email: "unknown@example.com",
    });

    const call = (mockDb.createContract as any).mock.calls[0][0];
    expect(call.message_account).toBeUndefined();
  });
});
