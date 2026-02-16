/**
 * VM Agent Loop — polls for PLANNING contracts, claims them, then:
 *   1. Executes via SSH/Bash (bridge.task with chrome: false)
 *   2. Validates via Chrome browser (bridge.task with chrome: true)
 *   3. Takes a screenshot for the reply email
 *
 * This is the VM-side counterpart to the Mac-side poller service.
 * The poller ingests emails and creates contracts; this loop executes them.
 */

import type { Db, Contract } from "../db.js";
import type { BridgeClient, McpCallResult } from "../bridge-client.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

export type VmAgentLoopOptions = {
  hostname: string;
  pollIntervalMs: number;
  db: Db;
  bridge: BridgeClient;
};

export function createVmAgentLoop(options: VmAgentLoopOptions) {
  const { hostname, pollIntervalMs, db, bridge } = options;

  if (!hostname) {
    throw new Error("hostname is required for VM agent loop");
  }

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let logger: Logger;
  let processing = false;

  async function tick() {
    // Prevent overlapping ticks — if a contract execution takes longer than
    // the poll interval, skip this tick entirely.
    if (processing) return;
    processing = true;

    try {
      const contracts = await db.pollContracts(hostname);

      for (const contract of contracts) {
        const claimed = await db.claimContract(contract.id, hostname);
        if (!claimed) {
          logger.debug(`[vm-agent-loop] Claim failed for #${contract.id}, skipping (likely claimed by another agent)`);
          continue;
        }

        try {
          await executeContract(claimed);
        } catch (err) {
          logger.error(`[vm-agent-loop] Execution failed for #${claimed.id}: ${err}`);
          try {
            await db.updateContract(claimed.id, {
              state: "STUCK",
              execution_log: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
              attempt_count: claimed.attempt_count + 1,
            });
          } catch {
            // If even the STUCK update fails, log and move on
            logger.error(`[vm-agent-loop] Failed to mark #${claimed.id} as STUCK after error`);
          }
        }
      }
    } catch (err) {
      logger.error(`[vm-agent-loop] Tick failed: ${err}`);
    } finally {
      processing = false;
    }
  }

  async function executeContract(contract: Contract): Promise<void> {
    // Fetch latest state
    const full = await db.getContract(contract.id);
    if (!full) {
      logger.error(`[vm-agent-loop] Contract #${contract.id} not found after claim`);
      return;
    }

    // Validate intent
    if (!full.intent || full.intent.trim() === "") {
      await db.updateContract(full.id, {
        state: "STUCK",
        execution_log: "Contract has empty intent — cannot execute",
        attempt_count: 1,
      });
      return;
    }

    // Read attachments
    const attachments: Array<{ fileId: string; content: unknown }> = [];
    for (const fileId of full.attachment_ids) {
      try {
        const result = await bridge.readAttachment(fileId);
        if (result.success) {
          attachments.push({ fileId, content: result.result });
        }
      } catch {
        logger.warn(`[vm-agent-loop] Failed to read attachment ${fileId} for #${full.id}`);
      }
    }

    const profile = (full.system_ref?.chrome_profile as string) ?? "default";
    let attemptCount = full.attempt_count;
    let previousFailure: string | null = null;
    const logEntries: string[] = [];

    while (attemptCount < full.max_attempts) {
      attemptCount++;

      // --- Execute (SSH/Bash — no Chrome) ---
      const execPrompt = buildExecPrompt(full, attachments, previousFailure, attemptCount);
      let execResult: McpCallResult;

      try {
        execResult = await bridge.task(execPrompt, { chrome: false });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logEntries.push(`Attempt ${attemptCount}: Execution error — ${errMsg}`);
        await db.updateContract(full.id, {
          state: "STUCK",
          execution_log: logEntries.join("\n"),
          attempt_count: attemptCount,
        });
        return;
      }

      if (!execResult.success) {
        const errMsg = execResult.error ?? "Unknown execution failure";
        logEntries.push(`Attempt ${attemptCount}: Execution failed — ${errMsg}`);
        await db.updateContract(full.id, {
          state: "STUCK",
          execution_log: logEntries.join("\n"),
          attempt_count: attemptCount,
        });
        return;
      }

      const execOutput = extractResultText(execResult);
      logEntries.push(`Attempt ${attemptCount}: Executed — ${truncate(execOutput, 200)}`);

      // --- QA (skip if no qa_doc) ---
      if (!full.qa_doc) {
        logEntries.push(`Attempt ${attemptCount}: No qa_doc — skipping QA`);
        await db.updateContract(full.id, {
          state: "DONE",
          execution_log: logEntries.join("\n"),
          attempt_count: attemptCount,
          qa_results: { passed: true, skipped: true },
          completed_at: new Date(),
        });
        return;
      }

      // --- QA (Chrome browser validation) ---
      const qaPrompt = buildQaPrompt(full);
      let qaResult: McpCallResult;

      try {
        qaResult = await bridge.task(qaPrompt, { chrome: true, profile });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logEntries.push(`Attempt ${attemptCount}: QA error — ${errMsg}`);
        await db.updateContract(full.id, {
          state: "STUCK",
          execution_log: logEntries.join("\n"),
          attempt_count: attemptCount,
        });
        return;
      }

      const qaOutput = extractResultText(qaResult);
      const passed = parseQaPassed(qaOutput);

      if (passed) {
        logEntries.push(`Attempt ${attemptCount}: QA PASSED — ${truncate(qaOutput, 200)}`);

        // Take screenshot via CDP — retry once on failure
        let screenshotPath: string | null = null;
        const ssPath = `/tmp/cos-qa-${full.id}.png`;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const ssResult = await bridge.screenshot(ssPath, profile);
            if (ssResult.success) {
              screenshotPath = ssPath;
              break;
            }
          } catch {
            // Will retry or fall through
          }
        }
        if (!screenshotPath) {
          logger.warn(`[vm-agent-loop] screenshot failed for contract #${full.id} after 2 attempts`);
        }

        await db.updateContract(full.id, {
          state: "DONE",
          qa_results: { passed: true, details: qaOutput, screenshot_path: screenshotPath },
          execution_log: logEntries.join("\n"),
          attempt_count: attemptCount,
          completed_at: new Date(),
        });
        return;
      }

      // QA failed — record and prepare for retry
      logEntries.push(`Attempt ${attemptCount}: QA FAILED — ${truncate(qaOutput, 200)}`);
      previousFailure = qaOutput;

      // Persist intermediate state (attempt count + qa failure)
      await db.updateContract(full.id, {
        qa_results: { passed: false, details: qaOutput },
        execution_log: logEntries.join("\n"),
        attempt_count: attemptCount,
      });

      // Loop continues to next attempt...
    }

    // Max attempts exhausted
    logEntries.push(`All ${full.max_attempts} attempts exhausted — marking STUCK`);
    await db.updateContract(full.id, {
      state: "STUCK",
      qa_results: { passed: false, details: previousFailure },
      execution_log: logEntries.join("\n"),
      attempt_count: attemptCount,
    });
  }

  return {
    id: "vm-agent-loop" as const,

    start: async (ctx: { logger: Logger }) => {
      logger = ctx.logger;
      logger.info(`[vm-agent-loop] Starting (hostname: ${hostname}, interval: ${pollIntervalMs}ms)`);
      await tick();
      intervalHandle = setInterval(tick, pollIntervalMs);
    },

    stop: async (ctx: { logger: Logger }) => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      ctx.logger.info("[vm-agent-loop] Agent loop stopped");
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildExecPrompt(
  contract: Contract,
  attachments: Array<{ fileId: string; content: unknown }>,
  previousFailure: string | null,
  attemptNumber: number,
): string {
  const parts: string[] = [];

  parts.push(`Execute the following task:\n\n${contract.intent}`);

  if (contract.project_id) {
    parts.push(`\nProject: ${contract.project_id}`);
  }

  // Include system reference for SSH/deployment context
  const sysRef = contract.system_ref ?? {};
  if (sysRef.ec2_instance_id || sysRef.repo_path || sysRef.domain) {
    parts.push("\n--- System Context ---");
    if (sysRef.ec2_instance_id) {
      parts.push(`EC2 Instance: ${sysRef.ec2_instance_id}`);
      parts.push(`SSH: Use 'aws ssm start-session --target ${sysRef.ec2_instance_id}' to connect.`);
    }
    if (sysRef.repo_path) {
      parts.push(`Application code: ${sysRef.repo_path}`);
    }
    if (sysRef.domain) {
      parts.push(`Application URL: https://${sysRef.domain}`);
    }
  }

  if (attachments.length > 0) {
    parts.push("\n--- Attachments ---");
    for (const att of attachments) {
      const content = typeof att.content === "string"
        ? att.content
        : JSON.stringify(att.content);
      parts.push(`\n[attachment ${att.fileId}]:\n${truncate(content, 2000)}`);
    }
  }

  if (previousFailure && attemptNumber > 1) {
    parts.push(`\n--- Previous Attempt Failed ---`);
    parts.push(`The previous attempt failed QA with this result:`);
    parts.push(previousFailure);
    parts.push(`Please fix the issue and try again.`);
  }

  return parts.join("\n");
}

function buildQaPrompt(contract: Contract): string {
  const parts = [
    "Verify the following QA criteria using the Chrome browser. Report PASS if all criteria are met, or FAIL with details if not.",
    "",
    `QA Criteria: ${contract.qa_doc}`,
    "",
    `Original task: ${contract.intent}`,
  ];

  const domain = (contract.system_ref ?? {}).domain as string | undefined;
  if (domain) {
    parts.push("");
    parts.push(`Application URL: https://${domain}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

function extractResultText(result: McpCallResult): string {
  if (!result.result) return "";
  if (typeof result.result === "string") return result.result;
  const obj = result.result as Record<string, unknown>;
  if (typeof obj.result === "string") return obj.result;
  return JSON.stringify(result.result);
}

function parseQaPassed(qaOutput: string): boolean {
  const upper = qaOutput.toUpperCase();
  // Explicit PASS/FAIL markers take priority
  if (upper.includes("QA FAIL") || upper.includes("FAIL:") || upper.includes("FAILED")) {
    return false;
  }
  if (upper.includes("PASS") || upper.includes("VERIFIED")) {
    return true;
  }
  // Default to fail if no clear signal
  return false;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
