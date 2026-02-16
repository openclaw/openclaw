import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createVmAgentLoop } from "./vm-agent-loop.js";
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
  it("polls, claims, reads, executes, runs QA, and marks DONE", async () => {
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

    // 4. Two chrome_task calls: execution + QA (screenshot uses separate endpoint)
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBe(2);

    // 5. Execution prompt contains intent text
    const execArgs = chromeCalls[0][1] as Record<string, unknown>;
    expect(execArgs.prompt).toContain("Update Schaumburg Sunday hours to 8-5");

    // 6. QA prompt contains qa_doc text
    const qaArgs = chromeCalls[1][1] as Record<string, unknown>;
    expect(qaArgs.prompt).toContain("verify Sunday hours show 8:00 AM - 5:00 PM");

    // 7. Execution and QA prompts are different
    expect(execArgs.prompt).not.toBe(qaArgs.prompt);

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
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const execCall = mcpCalls.find((c: unknown[]) => c[0] === "chrome_task");
    expect((execCall![1] as Record<string, unknown>).prompt).toContain("attachment");

    await loop.stop({ logger });
  });

  it("uses chrome_profile from system_ref", async () => {
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

    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCall = mcpCalls.find((c: unknown[]) => c[0] === "chrome_task");
    expect((chromeCall![1] as Record<string, unknown>).profile).toBe("zenex");

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

    let chromeCallCount = 0;
    const bridge = createMockBridge({
      mcpCall: vi.fn(async (toolName: string) => {
        if (toolName === "chrome_task") {
          chromeCallCount++;
          // Call 1: execution → success
          // Call 2: QA → FAIL
          // Call 3: re-execution → success
          // Call 4: QA → PASS
          if (chromeCallCount === 2) {
            return { success: true, result: { result: "QA FAIL: Hours still show old value 9-6" } };
          }
          return { success: true, result: { result: "Task completed successfully. PASS. Verified." } };
        }
        return { success: true };
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

    // 4 chrome_task calls total: exec + QA-fail + exec + QA-pass (screenshot uses separate endpoint)
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBe(4);

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

    let chromeCallCount = 0;
    const bridge = createMockBridge({
      mcpCall: vi.fn(async (toolName: string) => {
        if (toolName === "chrome_task") {
          chromeCallCount++;
          if (chromeCallCount === 2) {
            return { success: true, result: { result: "QA FAIL: Button not found on page" } };
          }
          return { success: true, result: { result: "Completed. PASS. Verified." } };
        }
        return { success: true };
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

    // The third chrome_task call (re-execution) should reference the failure
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    const retryExecPrompt = (chromeCalls[2][1] as Record<string, unknown>).prompt as string;
    expect(retryExecPrompt).toContain("Button not found");

    await loop.stop({ logger });
  });

  it("accumulates execution_log across retries", async () => {
    const contract = makeContract({ id: 22, max_attempts: 3 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    let chromeCallCount = 0;
    const bridge = createMockBridge({
      mcpCall: vi.fn(async (toolName: string) => {
        if (toolName === "chrome_task") {
          chromeCallCount++;
          if (chromeCallCount === 2) {
            return { success: true, result: { result: "QA FAIL: Wrong hours displayed" } };
          }
          return { success: true, result: { result: "Done. PASS. Verified." } };
        }
        return { success: true };
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

    let chromeCallCount = 0;
    const bridge = createMockBridge({
      mcpCall: vi.fn(async (toolName: string) => {
        if (toolName === "chrome_task") {
          chromeCallCount++;
          // Odd calls = execution (success), even calls = QA (always fail)
          if (chromeCallCount % 2 === 0) {
            return { success: true, result: { result: "QA FAIL: Still wrong" } };
          }
          return { success: true, result: { result: "Executed task" } };
        }
        return { success: true };
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

    // Exactly 6 chrome_task calls: 3 exec + 3 QA
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBe(6);

    // Final state = STUCK
    const updateCalls = (db.updateContract as ReturnType<typeof vi.fn>).mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].state).toBe("STUCK");
    expect(lastUpdate[1].attempt_count).toBe(3);
    expect(lastUpdate[1].qa_results.passed).toBe(false);

    await loop.stop({ logger });
  });

  it("max_attempts=1 means STUCK after exactly 2 chrome_task calls (no off-by-one)", async () => {
    const contract = makeContract({ id: 31, max_attempts: 1 });
    const claimed = makeContract({ ...contract, state: "IMPLEMENTING", claimed_by: HOSTNAME });

    const bridge = createMockBridge({
      mcpCall: vi.fn(async (toolName: string) => {
        if (toolName === "chrome_task") {
          return { success: true, result: { result: "QA FAIL: Nope" } };
        }
        return { success: true };
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

    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBe(2); // 1 exec + 1 QA, no retry

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
      mcpCall: vi.fn(async (toolName: string) => {
        if (toolName === "chrome_task") {
          return { success: true, result: { result: "QA FAIL" } };
        }
        return { success: true };
      }),
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
    expect(bridge.mcpCall).not.toHaveBeenCalled();
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

    // Only contract B was executed (chrome_task called with B's intent)
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBeGreaterThan(0);
    const execPrompt = (chromeCalls[0][1] as Record<string, unknown>).prompt as string;
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
      mcpCall: vi.fn(async () => {
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

    // Only 1 chrome_task call (execution only, no QA)
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBe(1);

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
      mcpCall: vi.fn(async () => ({
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

    // Both got chrome_task calls with their respective intents
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    const allPrompts = chromeCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).prompt as string);
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

    // Make chrome_task for contract A take longer than the poll interval
    let resolveA: (() => void) | null = null;
    let chromeCallCount = 0;

    const bridge = createMockBridge({
      mcpCall: vi.fn(async (toolName: string) => {
        if (toolName === "chrome_task") {
          chromeCallCount++;
          if (chromeCallCount === 1) {
            // First execution call: slow - wait for explicit resolve
            await new Promise<void>((resolve) => { resolveA = resolve; });
          }
          return { success: true, result: { result: "Done. PASS. Verified." } };
        }
        return { success: true };
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

    // 2 chrome_task calls only: exec + QA (screenshot uses separate endpoint)
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBe(2);

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

    // Only 1 chrome_task call (execution only, no QA)
    const mcpCalls = (bridge.mcpCall as ReturnType<typeof vi.fn>).mock.calls;
    const chromeCalls = mcpCalls.filter((c: unknown[]) => c[0] === "chrome_task");
    expect(chromeCalls.length).toBe(1);

    await loop.stop({ logger });
  });
});
