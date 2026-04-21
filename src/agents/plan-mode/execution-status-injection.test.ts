/**
 * P2.12b: tests for buildExecutionStatusInjection +
 * prependExecutionStatusIfExecuting.
 *
 * Coverage:
 *  - returns undefined for non-executing modes (plan, normal, missing)
 *  - returns undefined for sessions with no planMode at all
 *  - returns undefined for executing sessions with no lastPlanSteps
 *  - returns the preamble with correct counts for an executing session
 *  - includes in_progress step title when one exists
 *  - omits "Current in_progress step" line when no in_progress step or
 *    when the step is an empty string
 *  - truncates long step titles to ~140 chars (soft cap)
 *  - truncates long plan titles to ~120 chars (soft cap)
 *  - single-pass counter handles UNKNOWN status values with an
 *    "unrecognized" bucket (critical fail-safe from adversarial review)
 *  - composePromptWithPendingInjection semantics via
 *    prependExecutionStatusIfExecuting
 *  - fail-open: bad sessionKey / missing store / invalid JSON returns
 *    undefined, never throws
 *  - contains the canonical "authoritative-tool" instruction so the
 *    preamble no longer contradicts the nudge text
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildExecutionStatusInjection,
  prependExecutionStatusIfExecuting,
} from "./execution-status-injection.js";

describe("buildExecutionStatusInjection (P2.12b)", () => {
  let tmpBase: string;
  let storePath: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-status-"));
    storePath = path.join(tmpBase, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  async function writeStore(entries: Record<string, unknown>): Promise<void> {
    await fs.writeFile(storePath, JSON.stringify(entries), "utf-8");
  }

  it("returns undefined when the session is in plan (design) mode", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "plan",
          lastPlanSteps: [{ step: "do thing", status: "pending" }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the session is in normal mode", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: { mode: "normal", lastPlanSteps: [] },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the session has no planMode field", async () => {
    await writeStore({
      "agent:main:main": { channel: "terminal" },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeUndefined();
  });

  it("returns undefined when executing but no lastPlanSteps", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: { mode: "executing", title: "x" },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeUndefined();
  });

  it("returns preamble with correct step counts for an executing session", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "Trace Baoyu flyer install vs David VM",
          lastPlanSteps: [
            { step: "step 1", status: "completed" },
            { step: "step 2", status: "completed" },
            { step: "step 3", status: "in_progress" },
            { step: "step 4", status: "pending" },
            { step: "step 5", status: "pending" },
            { step: "step 6", status: "pending" },
          ],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeDefined();
    expect(result).toContain("[PLAN_STATUS]:");
    expect(result).toContain('"Trace Baoyu flyer install vs David VM"');
    expect(result).toContain("2/6 completed");
    expect(result).toContain("1 in_progress");
    expect(result).toContain("3 pending");
    // Zero-cancelled + zero-unknown are omitted from the count line.
    expect(result).not.toMatch(/\d+ cancelled/);
    expect(result).not.toMatch(/\d+ unrecognized/);
    expect(result).toContain('Current in_progress step: "step 3"');
  });

  it("includes cancelled count only when non-zero", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [
            { step: "a", status: "completed" },
            { step: "b", status: "cancelled" },
            { step: "c", status: "in_progress" },
          ],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toContain("1 cancelled");
  });

  it("includes an 'unrecognized' bucket when statuses don't match known values", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [
            { step: "a", status: "completed" },
            { step: "b", status: "skipped" }, // unrecognized
            { step: "c", status: "blocked" }, // unrecognized
            { step: "d", status: "pending" },
          ],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toContain("1/4 completed");
    expect(result).toContain("1 pending");
    expect(result).toContain("2 unrecognized");
    // The sum of known + unknown should equal total, so the agent has a
    // complete accounting even when statuses drift.
  });

  it("handles trailing-whitespace status as unrecognized (strict-match)", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [{ step: "a", status: "completed " }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toContain("1 unrecognized");
    // The trailing-whitespace entry must NOT be counted in the real
    // completed bucket — the count line should read "0/1 completed".
    expect(result).toContain("0/1 completed");
  });

  it("omits in_progress step line when no in_progress step exists", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [
            { step: "a", status: "completed" },
            { step: "b", status: "pending" },
          ],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeDefined();
    expect(result).not.toContain("Current in_progress step");
  });

  it("omits in_progress step line when the step text is an empty string", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [{ step: "", status: "in_progress" }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeDefined();
    expect(result).not.toContain("Current in_progress step");
  });

  it("truncates long step titles to the soft cap (~140 chars)", async () => {
    const longStep = "x".repeat(200);
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [{ step: longStep, status: "in_progress" }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeDefined();
    // 137 "x"s + "..." = 140 total in the inline step text
    expect(result).toContain(`${"x".repeat(137)}...`);
    expect(result).not.toContain("x".repeat(200));
  });

  it("truncates long plan titles to the tighter title cap (~120 chars)", async () => {
    const longTitle = "t".repeat(200);
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: longTitle,
          lastPlanSteps: [{ step: "a", status: "in_progress" }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeDefined();
    // 117 "t"s + "..." = 120 total for the title slot.
    expect(result).toContain(`${"t".repeat(117)}...`);
    expect(result).not.toContain("t".repeat(200));
  });

  it("uses '(untitled)' when planMode.title is missing", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          lastPlanSteps: [{ step: "a", status: "in_progress" }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toContain('"(untitled)"');
  });

  it("empty sessionKey returns undefined without throwing", async () => {
    const result = await buildExecutionStatusInjection("", { storePath });
    expect(result).toBeUndefined();
  });

  it("whitespace-only sessionKey returns undefined", async () => {
    const result = await buildExecutionStatusInjection("   ", { storePath });
    expect(result).toBeUndefined();
  });

  it("missing store file returns undefined (loadSessionStore returns {})", async () => {
    const result = await buildExecutionStatusInjection("agent:main:main", {
      storePath: path.join(tmpBase, "does-not-exist.json"),
    });
    expect(result).toBeUndefined();
  });

  it("malformed JSON on disk returns undefined (loadSessionStore catches parse errors)", async () => {
    await fs.writeFile(storePath, "{ this is not valid JSON", "utf-8");
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeUndefined();
  });

  it("session key not in store returns undefined", async () => {
    await writeStore({
      "agent:other:other": {
        planMode: {
          mode: "executing",
          lastPlanSteps: [{ step: "a", status: "pending" }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    expect(result).toBeUndefined();
  });

  it("contains the canonical 'plan_mode_status is authoritative' instruction", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [{ step: "a", status: "in_progress" }],
        },
      },
    });
    const result = await buildExecutionStatusInjection("agent:main:main", { storePath });
    // Adversarial review round-1 MAJOR 2: preamble language must DEFER
    // to the `plan_mode_status` tool, not compete with it by telling
    // the agent to "trust this snapshot over internal memory." The
    // snapshot is a best-effort turn-start read; the tool is the
    // single source of truth.
    expect(result).toContain("plan_mode_status` is authoritative");
    expect(result).toContain("captured at turn-start and may be stale");
    expect(result).toContain("close-on-complete fires automatically");
  });
});

describe("prependExecutionStatusIfExecuting (P2.12b convenience wrapper)", () => {
  let tmpBase: string;
  let storePath: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-status-"));
    storePath = path.join(tmpBase, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  async function writeStore(entries: Record<string, unknown>): Promise<void> {
    await fs.writeFile(storePath, JSON.stringify(entries), "utf-8");
  }

  it("returns prompt unchanged when session is not in executing mode", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: { mode: "plan", lastPlanSteps: [{ step: "a", status: "pending" }] },
      },
    });
    const result = await prependExecutionStatusIfExecuting("hello there", "agent:main:main", {
      storePath,
    });
    expect(result).toBe("hello there");
  });

  it("prepends the preamble to the prompt when executing", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [{ step: "a", status: "in_progress" }],
        },
      },
    });
    const result = await prependExecutionStatusIfExecuting(
      "[PLAN_NUDGE]: nudge text",
      "agent:main:main",
      { storePath },
    );
    expect(result).toMatch(/^\[PLAN_STATUS\]:/);
    expect(result).toContain("[PLAN_NUDGE]: nudge text");
    // Joined by exactly one blank line.
    expect(result).toMatch(/\n\n\[PLAN_NUDGE\]/);
  });

  it("returns only the preamble when prompt is empty / whitespace-only", async () => {
    await writeStore({
      "agent:main:main": {
        planMode: {
          mode: "executing",
          title: "plan",
          lastPlanSteps: [{ step: "a", status: "in_progress" }],
        },
      },
    });
    const result = await prependExecutionStatusIfExecuting("   ", "agent:main:main", {
      storePath,
    });
    expect(result).toMatch(/^\[PLAN_STATUS\]:/);
    // No trailing prompt artifact.
    expect(result.endsWith("\n\n")).toBe(false);
  });
});
