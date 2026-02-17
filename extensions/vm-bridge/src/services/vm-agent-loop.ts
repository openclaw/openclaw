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

    // --- Fetch DB schema for execution context ---
    let schemaContext: string | null = null;
    try {
      schemaContext = await fetchDbSchema(bridge, full.system_ref ?? {});
    } catch (err) {
      logger.warn(`[vm-agent-loop] Failed to fetch DB schema for #${full.id}: ${err}`);
    }
    if (!schemaContext && full.system_ref?.ec2_instance_id) {
      logger.warn(`[vm-agent-loop] No DB schema available for #${full.id} — executing without schema context`);
    }

    while (attemptCount < full.max_attempts) {
      attemptCount++;

      // --- Execute (SSH/Bash — no Chrome) ---
      const execPrompt = buildExecPrompt(full, attachments, previousFailure, attemptCount, schemaContext);
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
      const passed = parseQaPassed(qaOutput, full.qa_doc);

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

export function buildExecPrompt(
  contract: Contract,
  attachments: Array<{ fileId: string; content: unknown }>,
  previousFailure: string | null,
  attemptNumber: number,
  schemaContext?: string | null,
): string {
  const parts: string[] = [];

  // Schema first — so the agent understands the data model before reading the task
  if (schemaContext) {
    parts.push("--- Database Schema ---");
    parts.push("Use this schema to understand how the application stores data. Make changes that respect this structure.");
    parts.push(schemaContext);
    parts.push("");
  }

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

// ---------------------------------------------------------------------------
// DB schema introspection
// ---------------------------------------------------------------------------

export async function fetchDbSchema(
  bridge: BridgeClient,
  systemRef: Record<string, unknown>,
): Promise<string | null> {
  const instanceId = systemRef.ec2_instance_id as string | undefined;
  if (!instanceId) return null;

  const repoPath = (systemRef.repo_path as string) ?? "/opt/app";

  // Strategy 1: Read Prisma schema directly (preferred — includes relationships, enums, comments)
  const prismaPrompt = [
    `Connect to EC2 instance ${instanceId} via SSM.`,
    `Read the Prisma schema file: cat ${repoPath}/prisma/schema.prisma`,
    "",
    "Return the FULL file contents, no commentary.",
  ].join("\n");

  try {
    const prismaResult = await bridge.task(prismaPrompt, { chrome: false, timeout: 60 });
    if (prismaResult.success && prismaResult.result) {
      const text = typeof prismaResult.result === "string"
        ? prismaResult.result
        : JSON.stringify(prismaResult.result);
      if (text.includes("model ") && text.includes("@@map")) {
        return text;
      }
    }
  } catch {
    // Fall through to MySQL introspection
  }

  // Strategy 2: MySQL introspection (fallback — no relationships or enums)
  const mysqlPrompt = [
    `Connect to EC2 instance ${instanceId} via SSM and inspect the application database schema.`,
    `The application code is at ${repoPath}.`,
    "",
    "Steps:",
    "1. Find the database connection config in the application (check .env, config files, or environment variables)",
    "2. Connect to the database (likely MySQL on RDS)",
    "3. List all tables: SHOW TABLES",
    "4. For each table, run: DESCRIBE <table_name>",
    "5. Return the results as plain text in this format:",
    "   TABLE: <name> (<column1> <type>, <column2> <type>, ...)",
    "",
    "Return ONLY the schema listing, no commentary.",
  ].join("\n");

  try {
    const result = await bridge.task(mysqlPrompt, { chrome: false, timeout: 60 });
    if (result.success && result.result) {
      const text = typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result);
      return text;
    }
    return null;
  } catch {
    return null;
  }
}

type QaCheckItem = { id: string; description: string; nav: string; pass_if: string };

export function parseQaChecklist(qaDoc: string | null | undefined): QaCheckItem[] | null {
  if (!qaDoc || !qaDoc.trimStart().startsWith("[")) return null;
  try {
    const parsed = JSON.parse(qaDoc);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // Validate shape
    if (!parsed[0].id || !parsed[0].pass_if) return null;
    return parsed as QaCheckItem[];
  } catch {
    return null;
  }
}

export function buildQaPrompt(contract: Contract): string {
  const checklist = parseQaChecklist(contract.qa_doc);

  if (checklist) {
    const parts: string[] = [];
    parts.push(`Verify ALL ${checklist.length} criteria below using the Chrome browser on the deployed application.`);
    parts.push("Navigate to the URL in each check's 'nav' field and confirm the expected state is visible.");
    parts.push("Evaluate EACH check independently. Report per-check results.");
    parts.push("Only report overall PASS if ALL checks pass.");

    // Detect parity/snapshot checks and add specialized instructions
    const hasPositionalChecks = checklist.some(
      (c) => c.id.includes("parity") || c.id.includes("snapshot"),
    );
    if (hasPositionalChecks) {
      parts.push("");
      parts.push("IMPORTANT — This checklist contains snapshot and parity checks:");
      parts.push("1. FIRST query the current state of each entity (count, locations, types)");
      parts.push("2. THEN compare against the expected state described in each check");
      parts.push("3. Report exact numbers and lists — e.g. 'user has 107 records across 107 entries' not just 'user is present'");
      parts.push("4. For parity checks, list any locations where the target is missing but the reference entity is present");
    }

    parts.push("");

    checklist.forEach((check, i) => {
      parts.push(`Check ${i + 1}: ${check.id}`);
      parts.push(`  What: ${check.description}`);
      parts.push(`  Navigate: ${check.nav}`);
      parts.push(`  Pass if: ${check.pass_if}`);
      parts.push("");
    });

    parts.push(`Original task: ${contract.intent}`);

    const domain = (contract.system_ref ?? {}).domain as string | undefined;
    if (domain) {
      parts.push("");
      parts.push(`Application URL: https://${domain}`);
    }

    parts.push("");
    parts.push("After evaluating ALL checks, report in this exact format:");
    checklist.forEach((check) => {
      parts.push(`CHECK ${check.id}: PASS|FAIL - <evidence>`);
    });
    parts.push(`OVERALL: PASS|FAIL (n/${checklist.length} passed)`);

    return parts.join("\n");
  }

  // Legacy: free-text qa_doc
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

export function parseQaPassed(qaOutput: string, qaDoc?: string | null): boolean {
  const checklist = parseQaChecklist(qaDoc);

  if (checklist) {
    // Structured mode: require every check ID to have a PASS line, none FAIL
    for (const check of checklist) {
      const pattern = new RegExp(`CHECK\\s+${check.id}:\\s*(PASS|FAIL)`, "i");
      const match = qaOutput.match(pattern);
      if (!match) return false; // Missing check → fail
      if (match[1].toUpperCase() === "FAIL") return false;
    }
    return true;
  }

  // Legacy: keyword matching
  const upper = qaOutput.toUpperCase();
  if (upper.includes("QA FAIL") || upper.includes("FAIL:") || upper.includes("FAILED")) {
    return false;
  }
  if (upper.includes("PASS") || upper.includes("VERIFIED")) {
    return true;
  }
  return false;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
