import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createVmAgentLoop, buildQaPrompt, parseQaPassed, buildExecPrompt, fetchDbSchema } from "./vm-agent-loop.js";
import type { Db, Contract } from "../db.js";
import type { BridgeClient } from "../bridge-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 7,
    state: "PLANNING",
    intent: "Update Schaumburg Sunday hours to 8-5",
    qa_doc: "Navigate to GBP listing and verify Sunday hours show 8:00 AM - 5:00 PM",
    owner: "vvg-gbp-ec2",
    project_id: "vvg-gbp",
    claimed_by: null,
    system_ref: { chrome_profile: "vvg", repo_path: "/home/ubuntu/gbp" },
    message_id: "msg-outlook-1",
    message_platform: "outlook",
    message_account: null,
    sender_email: "jennifer@vvgtruck.com",
    sender_name: "Jennifer Holt",
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
    created_at: new Date("2026-02-14T10:00:00Z"),
    claimed_at: null,
    completed_at: null,
    updated_at: new Date("2026-02-14T10:00:00Z"),
    ...overrides,
  };
}

function createMockDb(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pollContracts: vi.fn(async () => []),
    claimContract: vi.fn(async () => null),
    getContract: vi.fn(async () => null),
    updateContract: vi.fn(async () => null),
    ...overrides,
  } as unknown as Db;
}

function createMockBridge(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mcpCall: vi.fn(async () => ({
      success: true,
      result: { result: "Task completed successfully. PASS" },
    })),
    task: vi.fn(async () => ({
      success: true,
      result: "Task completed successfully. PASS. Verified.",
    })),
    readAttachment: vi.fn(async () => ({
      success: true,
      result: { content: "attachment data" },
    })),
    screenshot: vi.fn(async () => ({ success: true, path: "/tmp/screenshot.png", size_bytes: 61000 })),
    ...overrides,
  } as unknown as BridgeClient;
}

const HOSTNAME = "vvg-gbp-ec2";
const POLL_MS = 15_000;

// ---------------------------------------------------------------------------
// Block 1: Service shape
// ---------------------------------------------------------------------------

describe("service registration", () => {
  it("has id 'vm-agent-loop'", () => {
    const db = createMockDb();
    const bridge = createMockBridge();
    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    expect(loop.id).toBe("vm-agent-loop");
  });

  it("has start and stop functions", () => {
    const db = createMockDb();
    const bridge = createMockBridge();
    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    expect(typeof loop.start).toBe("function");
    expect(typeof loop.stop).toBe("function");
  });

  it("throws when hostname is empty", () => {
    const db = createMockDb();
    const bridge = createMockBridge();
    expect(() => createVmAgentLoop({ hostname: "", pollIntervalMs: POLL_MS, db, bridge })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Block 2: Happy path — PLANNING → DONE
// ---------------------------------------------------------------------------

describe("happy path: PLANNING → DONE", () => {
  it("polls, claims, reads, executes via SSH, validates via Chrome, and marks DONE", async () => {
    const contract = makeContract();
    const claimed = makeContract({ state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // 1. Polled with correct hostname
    expect(db.pollContracts).toHaveBeenCalledWith(HOSTNAME);

    // 2. Claimed with correct args
    expect(db.claimContract).toHaveBeenCalledWith(7, HOSTNAME);

    // 3. Read full contract
    expect(db.getContract).toHaveBeenCalledWith(7);

    // 4. Two bridge.task() calls: execution (SSH) + QA (Chrome)
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(2);

    // 5. Execution call: chrome=false, prompt contains intent
    const execPrompt = taskCalls[0][0] as string;
    const execOpts = taskCalls[0][1] as Record<string, unknown>;
    expect(execPrompt).toContain("Update Schaumburg Sunday hours to 8-5");
    expect(execOpts.chrome).toBe(false);

    // 6. QA call: chrome=true, prompt contains qa_doc
    const qaPrompt = taskCalls[1][0] as string;
    const qaOpts = taskCalls[1][1] as Record<string, unknown>;
    expect(qaPrompt).toContain("verify Sunday hours show 8:00 AM - 5:00 PM");
    expect(qaOpts.chrome).toBe(true);

    // 7. Execution and QA prompts are different
    expect(execPrompt).not.toBe(qaPrompt);

    // 8. Final updateContract sets state=DONE with qa_results.passed=true
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[0]).toBe(7); // contract id
    expect(lastUpdate[1].state).toBe("DONE");
    expect(lastUpdate[1].qa_results.passed).toBe(true);
    expect(lastUpdate[1].attempt_count).toBe(1);
    expect(typeof lastUpdate[1].execution_log).toBe("string");
    expect(lastUpdate[1].execution_log.length).toBeGreaterThan(0);

    await loop.stop({ logger });
  });

  it("reads attachments when attachment_ids are present", async () => {
    const contract = makeContract({ attachment_ids: ["att-1", "att-2"] });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    expect(bridge.readAttachment).toHaveBeenCalledWith("att-1");
    expect(bridge.readAttachment).toHaveBeenCalledWith("att-2");

    // Attachment content should appear in the execution prompt
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    const execPrompt = taskCalls[0][0] as string;
    expect(execPrompt).toContain("attachment");

    await loop.stop({ logger });
  });

  it("uses chrome_profile from system_ref for QA step", async () => {
    const contract = makeContract({ system_ref: { chrome_profile: "zenex" } });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // QA call (second task call) should use the chrome profile
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    const qaOpts = taskCalls[1][1] as Record<string, unknown>;
    expect(qaOpts.profile).toBe("zenex");
    expect(qaOpts.chrome).toBe(true);

    await loop.stop({ logger });
  });

  it("stops polling after stop() is called", async () => {
    const db = createMockDb({
      pollContracts: vi.fn(async () => []),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const callsBefore = (db.pollContracts as ReturnType<typeof vi.fn>).mock.calls.length;
    await loop.stop({ logger });

    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect((db.pollContracts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Block 3: Retry path — QA fail then pass
// ---------------------------------------------------------------------------

describe("retry path: QA fail → retry → DONE", () => {
  it("retries execution when QA fails, succeeds on second attempt", async () => {
    const contract = makeContract({ id: 20, max_attempts: 3 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    let taskCallCount = 0;
    const bridge = createMockBridge({
      task: vi.fn(async () => {
        taskCallCount++;
        // Call 1: execution → success
        // Call 2: QA → FAIL
        // Call 3: re-execution → success
        // Call 4: QA → PASS
        if (taskCallCount === 2) {
          return { success: true, result: "QA FAIL: Hours still show old value 9-6" };
        }
        return { success: true, result: "Task completed successfully. PASS. Verified." };
      }),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // 4 task calls total: exec + QA-fail + exec + QA-pass (screenshot uses separate endpoint)
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(4);

    // Final update: DONE with attempt_count=2
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("DONE");
    expect(lastUpdate[1].attempt_count).toBe(2);
    expect(lastUpdate[1].qa_results.passed).toBe(true);

    await loop.stop({ logger });
  });

  it("retry prompt includes context about what failed", async () => {
    const contract = makeContract({ id: 21, max_attempts: 3 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    let taskCallCount = 0;
    const bridge = createMockBridge({
      task: vi.fn(async () => {
        taskCallCount++;
        if (taskCallCount === 2) {
          return { success: true, result: "QA FAIL: Button not found on page" };
        }
        return { success: true, result: "Completed. PASS. Verified." };
      }),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // The third task call (re-execution) should reference the failure
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    const retryExecPrompt = taskCalls[2][0] as string;
    expect(retryExecPrompt).toContain("Button not found");

    await loop.stop({ logger });
  });

  it("accumulates execution_log across retries", async () => {
    const contract = makeContract({ id: 22, max_attempts: 3 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    let taskCallCount = 0;
    const bridge = createMockBridge({
      task: vi.fn(async () => {
        taskCallCount++;
        if (taskCallCount === 2) {
          return { success: true, result: "QA FAIL: Wrong hours displayed" };
        }
        return { success: true, result: "Done. PASS. Verified." };
      }),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Final execution_log should mention both attempts
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    const log = lastUpdate[1].execution_log as string;
    expect(log).toContain("Attempt 1");
    expect(log).toContain("Attempt 2");

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 4: Max attempts exhausted → STUCK
// ---------------------------------------------------------------------------

describe("max attempts exhausted → STUCK", () => {
  it("marks STUCK after max_attempts QA failures", async () => {
    const contract = makeContract({ id: 30, max_attempts: 3 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    let taskCallCount = 0;
    const bridge = createMockBridge({
      task: vi.fn(async () => {
        taskCallCount++;
        // Odd calls = execution (success), even calls = QA (always fail)
        if (taskCallCount % 2 === 0) {
          return { success: true, result: "QA FAIL: Still wrong" };
        }
        return { success: true, result: "Executed task" };
      }),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Exactly 6 task calls: 3 exec + 3 QA
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(6);

    // Final state = STUCK
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("STUCK");
    expect(lastUpdate[1].attempt_count).toBe(3);
    expect(lastUpdate[1].qa_results.passed).toBe(false);

    await loop.stop({ logger });
  });

  it("max_attempts=1 means STUCK after exactly 2 task calls (no off-by-one)", async () => {
    const contract = makeContract({ id: 31, max_attempts: 1 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge({
      task: vi.fn(async () => ({
        success: true,
        result: "QA FAIL: Nope",
      })),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(2); // 1 exec + 1 QA, no retry

    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("STUCK");
    expect(lastUpdate[1].attempt_count).toBe(1);

    await loop.stop({ logger });
  });

  it("does not retry after reaching STUCK", async () => {
    const contract = makeContract({ id: 32, max_attempts: 1 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge({
      task: vi.fn(async () => ({
        success: true,
        result: "QA FAIL",
      })),
    });

    // Return contract on first poll, empty on subsequent polls
    let pollCount = 0;
    const db = createMockDb({
      pollContracts: vi.fn(async () => {
        pollCount++;
        return pollCount === 1 ? [contract] : [];
      }),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Advance past several ticks
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    // claimContract should only have been called once (first poll)
    expect(db.claimContract).toHaveBeenCalledTimes(1);

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 5: Race condition — claim fails
// ---------------------------------------------------------------------------

describe("race condition: concurrent claim", () => {
  it("skips contract when claim returns null", async () => {
    const contract = makeContract({ id: 40 });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => null), // Another agent won
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Claim was attempted
    expect(db.claimContract).toHaveBeenCalledWith(40, HOSTNAME);

    // But no execution happened
    expect(bridge.task).not.toHaveBeenCalled();
    expect(db.updateContract).not.toHaveBeenCalled();
    expect(db.getContract).not.toHaveBeenCalled();

    // No errors logged
    expect(logger.error).not.toHaveBeenCalled();

    await loop.stop({ logger });
  });

  it("processes remaining contracts when one claim fails", async () => {
    const contractA = makeContract({ id: 41, intent: "Task A" });
    const contractB = makeContract({ id: 42, intent: "Task B" });
    const claimedB = makeContract({ ...contractB, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contractA, contractB]),
      claimContract: vi.fn(async (id: number) => {
        if (id === 41) return null; // A lost race
        return claimedB; // B claimed
      }),
      getContract: vi.fn(async () => claimedB),
      updateContract: vi.fn(async () => claimedB),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Both claims attempted
    expect(db.claimContract).toHaveBeenCalledTimes(2);

    // Only contract B was executed (task called with B's intent)
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBeGreaterThan(0);
    const execPrompt = taskCalls[0][0] as string;
    expect(execPrompt).toContain("Task B");
    expect(execPrompt).not.toContain("Task A");

    await loop.stop({ logger });
  });

  it("logs failed claims at debug level", async () => {
    const contract = makeContract({ id: 43 });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => null),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("43"),
    );

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 6: Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  it("survives bridge ECONNREFUSED during execution → marks STUCK", async () => {
    const contract = makeContract({ id: 50 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge({
      task: vi.fn(async () => {
        throw new Error("Bridge unreachable: ECONNREFUSED");
      }),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Contract should be marked STUCK
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("STUCK");
    expect(lastUpdate[1].execution_log).toContain("ECONNREFUSED");

    // Loop still running — next tick should poll
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect((db.pollContracts as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    await loop.stop({ logger });
  });

  it("handles empty intent → marks STUCK with descriptive log", async () => {
    const contract = makeContract({ id: 51, intent: "" });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("STUCK");
    expect(lastUpdate[1].execution_log).toMatch(/intent|empty/i);

    await loop.stop({ logger });
  });

  it("handles null qa_doc → executes and marks DONE (skips QA)", async () => {
    const contract = makeContract({ id: 52, qa_doc: null });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Only 1 task call (execution only, no QA)
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(1);
    // Execution should be chrome: false
    expect(taskCalls[0][1].chrome).toBe(false);

    // Marked DONE
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("DONE");

    await loop.stop({ logger });
  });

  it("survives pollContracts failure → next tick still polls", async () => {
    let pollCount = 0;
    const db = createMockDb({
      pollContracts: vi.fn(async () => {
        pollCount++;
        if (pollCount === 1) throw new Error("DB connection lost");
        return [];
      }),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger }); // First tick: throws

    expect(logger.error).toHaveBeenCalled();

    // Second tick should still fire
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect((db.pollContracts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    await loop.stop({ logger });
  });

  it("survives updateContract failure → loop continues", async () => {
    const contract = makeContract({ id: 54, qa_doc: null });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => {
        throw new Error("UPDATE failed");
      }),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });

    // Should not throw
    await loop.start({ logger });

    // Error logged
    expect(logger.error).toHaveBeenCalled();

    // Next tick still fires
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect((db.pollContracts as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    await loop.stop({ logger });
  });

  it("treats bridge { success: false } as execution failure", async () => {
    const contract = makeContract({ id: 55, max_attempts: 1 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge({
      task: vi.fn(async () => ({
        success: false,
        error: "Task timed out after 300s",
      })),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("STUCK");
    expect(lastUpdate[1].execution_log).toContain("timed out");

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 7: Autonomous loop lifecycle
// ---------------------------------------------------------------------------

describe("autonomous loop lifecycle", () => {
  it("runs first tick immediately on start()", async () => {
    const db = createMockDb({
      pollContracts: vi.fn(async () => []),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // pollContracts called once before any timer advancement
    expect(db.pollContracts).toHaveBeenCalledTimes(1);

    await loop.stop({ logger });
  });

  it("polls repeatedly on interval", async () => {
    const db = createMockDb({
      pollContracts: vi.fn(async () => []),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    expect(db.pollContracts).toHaveBeenCalledTimes(1); // initial tick

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(db.pollContracts).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(db.pollContracts).toHaveBeenCalledTimes(3);

    await loop.stop({ logger });
  });

  it("stops cleanly — no more ticks after stop()", async () => {
    const db = createMockDb({
      pollContracts: vi.fn(async () => []),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });
    await loop.stop({ logger });

    const callsAfterStop = (db.pollContracts as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect((db.pollContracts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterStop);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
    );
  });

  it("processes multiple contracts across multiple ticks", async () => {
    const contractA = makeContract({ id: 60, intent: "First task" });
    const contractB = makeContract({ id: 61, intent: "Second task" });
    const claimedA = makeContract({ ...contractA, state: "IMPLEMENTING", claimed_by: HOSTNAME });
    const claimedB = makeContract({ ...contractB, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    let pollCount = 0;
    const db = createMockDb({
      pollContracts: vi.fn(async () => {
        pollCount++;
        if (pollCount === 1) return [contractA];
        if (pollCount === 2) return [contractB];
        return [];
      }),
      claimContract: vi.fn(async (id: number) => {
        return id === 60 ? claimedA : claimedB;
      }),
      getContract: vi.fn(async (id: number) => {
        return id === 60 ? claimedA : claimedB;
      }),
      updateContract: vi.fn(async () => null),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger }); // tick 1: process A

    await vi.advanceTimersByTimeAsync(POLL_MS); // tick 2: process B

    // Both contracts claimed
    expect(db.claimContract).toHaveBeenCalledWith(60, HOSTNAME);
    expect(db.claimContract).toHaveBeenCalledWith(61, HOSTNAME);

    // Both got task calls with their respective intents
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    const allPrompts = taskCalls.map((c: unknown[]) => c[0] as string);
    expect(allPrompts.some((p) => p.includes("First task"))).toBe(true);
    expect(allPrompts.some((p) => p.includes("Second task"))).toBe(true);

    // Both got updateContract calls
    expect((db.updateContract as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

    await loop.stop({ logger });
  });

  it("does not start new contract while current one is in-flight (sequential processing)", async () => {
    const contractA = makeContract({ id: 70, intent: "Slow task" });
    const contractB = makeContract({ id: 71, intent: "Fast task" });
    const claimedA = makeContract({ ...contractA, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    // Make bridge.task for contract A take longer than the poll interval
    let resolveA: (() => void) | null = null;
    let taskCallCount = 0;

    const bridge = createMockBridge({
      task: vi.fn(async () => {
        taskCallCount++;
        if (taskCallCount === 1) {
          // First execution call: slow - wait for explicit resolve
          await new Promise<void>((resolve) => { resolveA = resolve; });
        }
        return { success: true, result: "Done. PASS. Verified." };
      }),
    });

    let pollCount = 0;
    const db = createMockDb({
      pollContracts: vi.fn(async () => {
        pollCount++;
        if (pollCount === 1) return [contractA];
        return [contractB]; // B available on subsequent polls
      }),
      claimContract: vi.fn(async () => claimedA),
      getContract: vi.fn(async () => claimedA),
      updateContract: vi.fn(async () => null),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });

    // Start the loop — tick 1 begins processing A (but A's execution is slow)
    const startPromise = loop.start({ logger });

    // Advance past the poll interval while A is still executing
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // At this point: A is still in-flight. B should NOT have been claimed yet.
    // Only 1 claim should have happened (for A in the first tick).
    expect(db.claimContract).toHaveBeenCalledTimes(1);

    // Resolve A's execution
    resolveA!();
    await startPromise;

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 8: Screenshot capture after QA passes
// ---------------------------------------------------------------------------

describe("screenshot capture after QA pass", () => {
  it("calls bridge.screenshot() after QA passes", async () => {
    const contract = makeContract({ id: 77 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge();
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // bridge.screenshot() should be called once
    expect(bridge.screenshot).toHaveBeenCalledTimes(1);

    // 2 task calls only: exec (SSH) + QA (Chrome). Screenshot uses separate endpoint.
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(2);

    // Final updateContract includes screenshot_path in qa_results
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("DONE");
    expect(lastUpdate[1].qa_results.screenshot_path).toBeTruthy();

    await loop.stop({ logger });
  });

  it("screenshot save_path includes contract ID for unique filename", async () => {
    const contract = makeContract({ id: 77 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge();
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const ssCall = (bridge.screenshot as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ssCall[0]).toBe("/tmp/cos-qa-77.png");

    await loop.stop({ logger });
  });

  it("qa_results.screenshot_path matches the save_path passed to bridge.screenshot()", async () => {
    const contract = makeContract({ id: 77 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge();
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].qa_results.screenshot_path).toBe("/tmp/cos-qa-77.png");

    await loop.stop({ logger });
  });

  it("screenshot failure is non-fatal — still marks DONE", async () => {
    const contract = makeContract({ id: 78 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge({
      screenshot: vi.fn(async () => ({ success: false, error: "Browser not responding" })),
    });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Still marked DONE despite screenshot failure
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("DONE");
    expect(lastUpdate[1].qa_results.passed).toBe(true);
    // screenshot_path should be null when screenshot fails
    expect(lastUpdate[1].qa_results.screenshot_path).toBeNull();

    await loop.stop({ logger });
  });

  it("no screenshot taken when QA is skipped (null qa_doc)", async () => {
    const contract = makeContract({ id: 79, qa_doc: null });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge();
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // bridge.screenshot() should NOT be called when QA is skipped
    expect(bridge.screenshot).not.toHaveBeenCalled();

    // Only 1 task call (execution only, no QA)
    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(1);

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 8b: Screenshot retry guarantee
// ---------------------------------------------------------------------------

describe("screenshot retry guarantee", () => {
  it("retries screenshot once after initial failure", async () => {
    const contract = makeContract({ id: 90 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    // First call fails, second succeeds
    const screenshotMock = vi.fn()
      .mockResolvedValueOnce({ success: false, error: "Browser not responding" })
      .mockResolvedValueOnce({ success: true, path: "/tmp/cos-qa-90.png", size_bytes: 50000 });

    const bridge = createMockBridge({ screenshot: screenshotMock });
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Should have retried — 2 calls total
    expect(screenshotMock).toHaveBeenCalledTimes(2);

    // screenshot_path should be set (retry succeeded)
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("DONE");
    expect(lastUpdate[1].qa_results.screenshot_path).toBe("/tmp/cos-qa-90.png");

    await loop.stop({ logger });
  });

  it("logs warning when screenshot fails after retry", async () => {
    const contract = makeContract({ id: 91 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    // Both calls fail
    const screenshotMock = vi.fn()
      .mockResolvedValueOnce({ success: false, error: "Browser not responding" })
      .mockResolvedValueOnce({ success: false, error: "Still not responding" });

    const bridge = createMockBridge({ screenshot: screenshotMock });
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // Retried once — 2 calls total
    expect(screenshotMock).toHaveBeenCalledTimes(2);

    // screenshot_path should be null (both attempts failed)
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].qa_results.screenshot_path).toBeNull();

    // Should log a warning about screenshot failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("screenshot"),
    );

    await loop.stop({ logger });
  });

  it("retries on screenshot exception (throw) as well", async () => {
    const contract = makeContract({ id: 92 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    // First call throws, second succeeds
    const screenshotMock = vi.fn()
      .mockRejectedValueOnce(new Error("CDP connection lost"))
      .mockResolvedValueOnce({ success: true, path: "/tmp/cos-qa-92.png", size_bytes: 40000 });

    const bridge = createMockBridge({ screenshot: screenshotMock });
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    expect(screenshotMock).toHaveBeenCalledTimes(2);

    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].qa_results.screenshot_path).toBe("/tmp/cos-qa-92.png");

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 9: Two-step execution — SSH + Chrome
// ---------------------------------------------------------------------------

describe("two-step execution: SSH execute + Chrome QA", () => {
  it("execution prompt includes system_ref (EC2 ID, repo path, domain)", async () => {
    const contract = makeContract({
      id: 80,
      system_ref: {
        chrome_profile: "vvg",
        ec2_instance_id: "i-0eb126d7105e24581",
        repo_path: "/opt/gbp-app/current",
        domain: "customer-response.vtc.systems",
      },
    });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    // taskCalls[0] = Prisma schema fetch, taskCalls[1] = MySQL schema fallback, taskCalls[2] = exec prompt
    const execPrompt = taskCalls[2][0] as string;

    expect(execPrompt).toContain("i-0eb126d7105e24581");
    expect(execPrompt).toContain("/opt/gbp-app/current");
    expect(execPrompt).toContain("customer-response.vtc.systems");
    expect(execPrompt).toContain("aws ssm start-session");

    await loop.stop({ logger });
  });

  it("QA prompt includes domain URL for Chrome navigation", async () => {
    const contract = makeContract({
      id: 81,
      system_ref: {
        chrome_profile: "vvg",
        domain: "customer-response.vtc.systems",
      },
    });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    const qaPrompt = taskCalls[1][0] as string;

    expect(qaPrompt).toContain("https://customer-response.vtc.systems");
    expect(qaPrompt).toContain("Chrome browser");

    await loop.stop({ logger });
  });

  it("execution uses chrome: false, QA uses chrome: true", async () => {
    const contract = makeContract({ id: 82 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const bridge = createMockBridge();
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
    expect(taskCalls.length).toBe(2);

    // First call = execution (SSH)
    expect(taskCalls[0][1].chrome).toBe(false);
    // Second call = QA (Chrome)
    expect(taskCalls[1][1].chrome).toBe(true);

    await loop.stop({ logger });
  });
});

// ---------------------------------------------------------------------------
// Block 10: Structured QA checklist
// ---------------------------------------------------------------------------

const STRUCTURED_QA_DOC = JSON.stringify([
  { id: "user_added", description: "jshearer in recipients list", nav: "customer-response.vtc.systems/admin/settings", pass_if: "jshearer@vvgtruck.com listed as Active" },
  { id: "correct_scope", description: "Only Service dept locations", nav: "Location Subscriptions tab", pass_if: "Only VTC USA Service locations checked" },
  { id: "existing_unchanged", description: "cabarca still present", nav: "Recipients tab", pass_if: "cabarca@vvgtruck.com still listed" },
]);

describe("structured QA checklist", () => {
  describe("buildQaPrompt", () => {
    it("renders numbered checklist for structured qa_doc", () => {
      const contract = makeContract({ qa_doc: STRUCTURED_QA_DOC });
      const prompt = buildQaPrompt(contract);

      expect(prompt).toContain("Check 1:");
      expect(prompt).toContain("Check 2:");
      expect(prompt).toContain("Check 3:");
      expect(prompt).toContain("ALL 3 criteria");
      expect(prompt).toContain("jshearer@vvgtruck.com listed as Active");
      expect(prompt).toContain("Only VTC USA Service locations checked");
      expect(prompt).toContain("cabarca@vvgtruck.com still listed");
      // Must include per-check reporting format
      expect(prompt).toContain("CHECK user_added: PASS");
      expect(prompt).toContain("OVERALL:");
    });

    it("passes through legacy qa_doc unchanged", () => {
      const legacyDoc = "Navigate to GBP listing and verify Sunday hours show 8:00 AM - 5:00 PM";
      const contract = makeContract({ qa_doc: legacyDoc });
      const prompt = buildQaPrompt(contract);

      expect(prompt).toContain(legacyDoc);
      expect(prompt).not.toContain("Check 1:");
    });

    it("includes snapshot/parity instructions when checks contain parity or snapshot IDs", () => {
      const positionalDoc = JSON.stringify([
        { id: "jshearer_added", description: "jshearer subscribed", nav: "DB query", pass_if: "jshearer has active subscriptions" },
        { id: "jshearer_parity_cabarca", description: "jshearer matches cabarca", nav: "DB compare", pass_if: "jshearer subscribed everywhere cabarca is" },
        { id: "cabarca_snapshot", description: "cabarca unchanged", nav: "DB query", pass_if: "cabarca subscription count identical to pre-execution" },
      ]);
      const contract = makeContract({ qa_doc: positionalDoc });
      const prompt = buildQaPrompt(contract);

      expect(prompt).toContain("snapshot and parity checks");
      expect(prompt).toContain("query the current state");
      expect(prompt).toContain("Report exact numbers");
      expect(prompt).toContain("parity checks, list any");
    });

    it("omits snapshot/parity instructions for plain action checks", () => {
      // STRUCTURED_QA_DOC has ids: user_added, correct_scope, existing_unchanged — no parity/snapshot
      const contract = makeContract({ qa_doc: STRUCTURED_QA_DOC });
      const prompt = buildQaPrompt(contract);

      expect(prompt).not.toContain("snapshot and parity checks");
      expect(prompt).not.toContain("query the current state");
    });
  });

  describe("parseQaPassed", () => {
    it("returns true when ALL checks pass (structured)", () => {
      const output = [
        "CHECK user_added: PASS - jshearer found in list",
        "CHECK correct_scope: PASS - only Service locations checked",
        "CHECK existing_unchanged: PASS - cabarca still present",
        "OVERALL: PASS (3/3 passed)",
      ].join("\n");

      expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(true);
    });

    it("returns false when any check fails (structured)", () => {
      const output = [
        "CHECK user_added: PASS - jshearer found",
        "CHECK correct_scope: FAIL - all locations were checked, not just Service",
        "CHECK existing_unchanged: PASS - cabarca present",
        "OVERALL: FAIL (2/3 passed)",
      ].join("\n");

      expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(false);
    });

    it("returns false when checks are missing from output", () => {
      const output = [
        "CHECK user_added: PASS - found",
        "OVERALL: PASS (1/1 passed)",
      ].join("\n");

      // Only 1 of 3 checks reported — should fail
      expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(false);
    });

    it("still works with legacy qa_doc (keyword matching)", () => {
      const legacyDoc = "Verify the hours are updated";
      expect(parseQaPassed("QA PASS: Hours show correctly", legacyDoc)).toBe(true);
      expect(parseQaPassed("QA FAIL: Hours still wrong", legacyDoc)).toBe(false);
    });

    it("falls back to keyword matching when qa_doc is null", () => {
      expect(parseQaPassed("PASS. Verified.", null)).toBe(true);
      expect(parseQaPassed("FAILED to verify", null)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Block 11: DB schema context in execution prompt
// ---------------------------------------------------------------------------

const SAMPLE_SCHEMA = [
  "TABLE: recipients (id, email, name, type, active, createdAt, updatedAt)",
  "TABLE: location_contacts (id, locationId, email, name, alertTypes, active)",
  "TABLE: locations (id, name, brand, department, city, state)",
].join("\n");

const SAMPLE_PRISMA_SCHEMA = `model EmailRecipient {
  id    String @id @default(cuid())
  email String @unique @map("email")
  name  String? @map("name")
  type  String @map("recipient_type") // 'monthly', 'all'
  active Boolean @default(true)
  @@map("email_recipients")
}

model LocationContact {
  id         String @id @default(cuid())
  locationId String @map("location_id")
  contactType String @map("contact_type") // 'daily', 'weekly', 'all'
  email      String @map("email")
  name       String? @map("name")
  active     Boolean @default(true)
  location   Location @relation(fields: [locationId], references: [id])
  @@map("location_contacts")
}`;

describe("DB schema context in execution prompt", () => {
  describe("buildExecPrompt", () => {
    it("includes schema context when provided", () => {
      const contract = makeContract({
        system_ref: { ec2_instance_id: "i-abc123", repo_path: "/opt/app" },
      });
      const prompt = buildExecPrompt(contract, [], null, 1, SAMPLE_SCHEMA);

      expect(prompt).toContain("--- Database Schema ---");
      expect(prompt).toContain("TABLE: recipients");
      expect(prompt).toContain("TABLE: location_contacts");
      expect(prompt).toContain("TABLE: locations");
    });

    it("omits schema section when schemaContext is null", () => {
      const contract = makeContract({
        system_ref: { ec2_instance_id: "i-abc123", repo_path: "/opt/app" },
      });
      const prompt = buildExecPrompt(contract, [], null, 1, null);

      expect(prompt).not.toContain("Database Schema");
    });

    it("omits schema section when schemaContext is empty string", () => {
      const contract = makeContract();
      const prompt = buildExecPrompt(contract, [], null, 1, "");

      expect(prompt).not.toContain("Database Schema");
    });

    it("places schema before the task instruction so agent reads it first", () => {
      const contract = makeContract({
        intent: "Add jshearer to recipients",
        system_ref: { ec2_instance_id: "i-abc123" },
      });
      const prompt = buildExecPrompt(contract, [], null, 1, SAMPLE_SCHEMA);

      const schemaPos = prompt.indexOf("--- Database Schema ---");
      const taskPos = prompt.indexOf("Execute the following task:");
      expect(schemaPos).toBeGreaterThan(-1);
      expect(taskPos).toBeGreaterThan(-1);
      expect(schemaPos).toBeLessThan(taskPos);
    });
  });

  describe("fetchDbSchema", () => {
    it("prefers Prisma schema when available", async () => {
      const bridge = createMockBridge({
        task: vi.fn(async () => ({
          success: true,
          result: SAMPLE_PRISMA_SCHEMA,
        })),
      });

      const schema = await fetchDbSchema(bridge, {
        ec2_instance_id: "i-0eb126d7105e24581",
        repo_path: "/opt/gbp-app/current",
      });

      expect(schema).toContain("model EmailRecipient");
      expect(schema).toContain("model LocationContact");
      expect(schema).toContain("@@map");
      // Only 1 call needed — Prisma succeeded
      expect(bridge.task).toHaveBeenCalledTimes(1);
      const taskCall = (bridge.task as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(taskCall[0]).toContain("schema.prisma");
      expect(taskCall[0]).toContain("i-0eb126d7105e24581");
      expect(taskCall[1].chrome).toBe(false);
    });

    it("falls back to MySQL DESCRIBE when Prisma schema not found", async () => {
      let callCount = 0;
      const bridge = createMockBridge({
        task: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            // Prisma file not found
            return { success: true, result: "No such file or directory" };
          }
          // MySQL fallback
          return { success: true, result: SAMPLE_SCHEMA };
        }),
      });

      const schema = await fetchDbSchema(bridge, {
        ec2_instance_id: "i-0eb126d7105e24581",
        repo_path: "/opt/gbp-app/current",
      });

      expect(schema).toContain("TABLE: recipients");
      // 2 calls: Prisma (failed) + MySQL (succeeded)
      expect(bridge.task).toHaveBeenCalledTimes(2);
      const mysqlCall = (bridge.task as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(mysqlCall[0]).toContain("SHOW TABLES");
    });

    it("returns null when both strategies fail", async () => {
      const bridge = createMockBridge({
        task: vi.fn(async () => ({
          success: false,
          error: "SSH connection refused",
        })),
      });

      const schema = await fetchDbSchema(bridge, {
        ec2_instance_id: "i-0eb126d7105e24581",
        repo_path: "/opt/gbp-app/current",
      });

      expect(schema).toBeNull();
    });

    it("returns null when no ec2_instance_id in system_ref", async () => {
      const bridge = createMockBridge();

      const schema = await fetchDbSchema(bridge, {});

      expect(schema).toBeNull();
      // Should NOT have called bridge.task at all
      expect(bridge.task).not.toHaveBeenCalled();
    });
  });

  describe("executeContract integration", () => {
    it("fetches DB schema and includes it in exec prompt", async () => {
      const contract = makeContract({
        id: 90,
        system_ref: {
          ec2_instance_id: "i-0eb126d7105e24581",
          repo_path: "/opt/gbp-app/current",
          chrome_profile: "default",
        },
      });
      const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

      let taskCallCount = 0;
      const bridge = createMockBridge({
        task: vi.fn(async (prompt: string, opts: Record<string, unknown>) => {
          taskCallCount++;
          if (taskCallCount === 1) {
            // First call = Prisma schema fetch (succeeds)
            return { success: true, result: SAMPLE_PRISMA_SCHEMA };
          }
          // Subsequent calls = execution + QA
          return { success: true, result: "Task completed. PASS. Verified." };
        }),
      });

      const db = createMockDb({
        pollContracts: vi.fn(async () => [contract]),
        claimContract: vi.fn(async () => claimed),
        getContract: vi.fn(async () => claimed),
        updateContract: vi.fn(async () => claimed),
      });

      const logger = makeLogger();
      const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
      await loop.start({ logger });

      // bridge.task: 1) Prisma schema, 2) execution, 3) QA
      const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
      expect(taskCalls.length).toBeGreaterThanOrEqual(3);

      // Second call (execution) should contain the Prisma schema
      const execPrompt = taskCalls[1][0] as string;
      expect(execPrompt).toContain("--- Database Schema ---");
      expect(execPrompt).toContain("model EmailRecipient");
      expect(execPrompt).toContain("model LocationContact");

      await loop.stop({ logger });
    });

    it("still executes when schema fetch fails", async () => {
      const contract = makeContract({
        id: 91,
        system_ref: {
          ec2_instance_id: "i-0eb126d7105e24581",
          repo_path: "/opt/gbp-app/current",
          chrome_profile: "default",
        },
      });
      const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

      let taskCallCount = 0;
      const bridge = createMockBridge({
        task: vi.fn(async () => {
          taskCallCount++;
          // First 2 calls = schema fetch (Prisma fails, MySQL fails)
          if (taskCallCount <= 2) {
            return { success: false, error: "SSH timeout" };
          }
          return { success: true, result: "Task completed. PASS. Verified." };
        }),
      });

      const db = createMockDb({
        pollContracts: vi.fn(async () => [contract]),
        claimContract: vi.fn(async () => claimed),
        getContract: vi.fn(async () => claimed),
        updateContract: vi.fn(async () => claimed),
      });

      const logger = makeLogger();
      const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
      await loop.start({ logger });

      // Execution should still proceed (schema failure is non-fatal)
      const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
      // Prisma fail (1) + MySQL fail (2) + execution (3) + QA (4)
      expect(taskCalls.length).toBeGreaterThanOrEqual(4);

      // Exec prompt (3rd call) should NOT contain schema (both failed)
      const execPrompt = taskCalls[2][0] as string;
      expect(execPrompt).not.toContain("--- Database Schema ---");

      // Warning should be logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("schema"),
      );

      await loop.stop({ logger });
    });

    it("skips schema fetch when contract has no ec2_instance_id", async () => {
      const contract = makeContract({
        id: 92,
        system_ref: { chrome_profile: "vvg" },
      });
      const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

      const bridge = createMockBridge();
      const db = createMockDb({
        pollContracts: vi.fn(async () => [contract]),
        claimContract: vi.fn(async () => claimed),
        getContract: vi.fn(async () => claimed),
        updateContract: vi.fn(async () => claimed),
      });

      const logger = makeLogger();
      const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
      await loop.start({ logger });

      // Only 2 task calls: execution + QA (no schema fetch)
      const taskCalls = (bridge.task as ReturnType<typeof vi.fn>).mock.calls;
      expect(taskCalls.length).toBe(2);

      await loop.stop({ logger });
    });
  });
});

// ---------------------------------------------------------------------------
// Block 12: parseQaPassed — robust LLM output handling
// ---------------------------------------------------------------------------

describe("parseQaPassed: robust LLM output handling", () => {
  it("handles extra whitespace and newlines between checks", () => {
    const output = [
      "CHECK  user_added:  PASS  - found",
      "",
      "",
      "CHECK  correct_scope:  PASS",
      "CHECK  existing_unchanged:  PASS",
    ].join("\n");

    expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(true);
  });

  it("handles markdown bold formatting around CHECK", () => {
    const output = [
      "**CHECK user_added: PASS** - found",
      "**CHECK correct_scope: PASS**",
      "**CHECK existing_unchanged: PASS**",
    ].join("\n");

    expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(true);
  });

  it("handles bullet-point prefixed CHECK lines", () => {
    const output = [
      "- CHECK user_added: PASS - found",
      "- CHECK correct_scope: PASS",
      "- CHECK existing_unchanged: PASS",
    ].join("\n");

    expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(true);
  });

  it("handles multi-line evidence after PASS/FAIL without breaking subsequent checks", () => {
    const output = [
      "CHECK user_added: PASS",
      "  Evidence: found jshearer in 14 rows across 14 cities",
      "  Count: 14",
      "CHECK correct_scope: PASS",
      "  All locations are Service dept",
      "CHECK existing_unchanged: PASS",
      "  cabarca unchanged at 50 rows",
    ].join("\n");

    expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(true);
  });

  it("rejects prose that mentions check IDs without structured CHECK format", () => {
    const output =
      "I verified user_added and it passed. correct_scope looks good. existing_unchanged confirmed.";

    expect(parseQaPassed(output, STRUCTURED_QA_DOC)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Block 13: Screenshot during QA (not post-QA)
// ---------------------------------------------------------------------------

describe("screenshot during QA (not post-QA)", () => {
  it("buildQaPrompt includes screenshot instruction", () => {
    const contract = makeContract({ qa_doc: STRUCTURED_QA_DOC });
    const prompt = buildQaPrompt(contract);

    // The QA prompt should instruct the agent to take a screenshot during
    // verification so evidence is captured at the moment of checking, not
    // as a separate post-QA CDP call.
    const lower = prompt.toLowerCase();
    const hasScreenshotInstruction =
      lower.includes("screenshot") || (lower.includes("capture") && lower.includes("page"));
    expect(hasScreenshotInstruction).toBe(true);
  });

  it("QA output with screenshot path is used instead of bridge.screenshot()", async () => {
    const contract = makeContract({
      id: 100,
      qa_doc: STRUCTURED_QA_DOC,
    });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const qaOutputWithScreenshot = [
      "CHECK user_added: PASS - jshearer@vvgtruck.com listed as Active",
      "CHECK correct_scope: PASS - Only VTC USA Service locations checked",
      "CHECK existing_unchanged: PASS - cabarca@vvgtruck.com still listed",
      "OVERALL: PASS (3/3 passed)",
      "SCREENSHOT: /tmp/cos-qa-100.png",
    ].join("\n");

    const taskMock = vi.fn()
      // First call: execution (SSH)
      .mockResolvedValueOnce({ success: true, result: "Execution complete." })
      // Second call: QA (Chrome) — includes SCREENSHOT line
      .mockResolvedValueOnce({ success: true, result: qaOutputWithScreenshot });

    const bridge = createMockBridge({ task: taskMock });
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // bridge.screenshot() should NOT be called — QA agent already captured it
    expect(bridge.screenshot).not.toHaveBeenCalled();

    // qa_results.screenshot_path should come from the QA output, not CDP
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("DONE");
    expect(lastUpdate[1].qa_results.screenshot_path).toBe("/tmp/cos-qa-100.png");

    await loop.stop({ logger });
  });

  it("falls back to bridge.screenshot when QA output has no screenshot path", async () => {
    const contract = makeContract({
      id: 101,
      qa_doc: STRUCTURED_QA_DOC,
    });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const qaOutputNoScreenshot = [
      "CHECK user_added: PASS - jshearer@vvgtruck.com listed as Active",
      "CHECK correct_scope: PASS - Only VTC USA Service locations checked",
      "CHECK existing_unchanged: PASS - cabarca@vvgtruck.com still listed",
      "OVERALL: PASS (3/3 passed)",
    ].join("\n");

    const taskMock = vi.fn()
      // First call: execution (SSH)
      .mockResolvedValueOnce({ success: true, result: "Execution complete." })
      // Second call: QA (Chrome) — no SCREENSHOT line
      .mockResolvedValueOnce({ success: true, result: qaOutputNoScreenshot });

    const bridge = createMockBridge({ task: taskMock });
    const db = createMockDb({
      pollContracts: vi.fn(async () => [contract]),
      claimContract: vi.fn(async () => claimed),
      getContract: vi.fn(async () => claimed),
      updateContract: vi.fn(async () => claimed),
    });
    const logger = makeLogger();

    const loop = createVmAgentLoop({ hostname: HOSTNAME, pollIntervalMs: POLL_MS, db, bridge });
    await loop.start({ logger });

    // bridge.screenshot() SHOULD be called as fallback (no SCREENSHOT in QA output)
    expect(bridge.screenshot).toHaveBeenCalled();

    // qa_results.screenshot_path comes from bridge.screenshot result
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("DONE");
    expect(lastUpdate[1].qa_results.screenshot_path).toBe("/tmp/cos-qa-101.png");

    await loop.stop({ logger });
  });
});