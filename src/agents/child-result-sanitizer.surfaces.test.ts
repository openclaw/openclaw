import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPostCompactionContext } from "../auto-reply/reply/post-compaction-context.js";
import { normalizeMessagesForLlmBoundary } from "./pi-embedded-runner/run/attempt.js";
import { __testing as compactionTesting } from "./pi-hooks/compaction-safeguard.js";

const BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";
const PLACEHOLDER = "[OpenClaw sanitized child result:";

describe("child result sanitizer integration surfaces", () => {
  it("sanitizes active transcript prompt reconstruction messages", () => {
    const rawNeedle = "PROMPT_RECONSTRUCTION_SURFACE_SECRET_LINE";
    const messages = normalizeMessagesForLlmBoundary([
      { role: "assistant", content: `${BEGIN}\n${rawNeedle}\n${END}` } as never,
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(PLACEHOLDER);
    expect(serialized).not.toContain(rawNeedle);
  });

  it("sanitizes compaction summary output while preserving safe suffixes", () => {
    const rawNeedle = "COMPACTION_SURFACE_SECRET_LINE";
    const summary = compactionTesting.capCompactionSummaryPreservingSuffix(
      `${BEGIN}\n${rawNeedle}\n${END}`,
      "\n\n## Safe suffix",
      1000,
    );
    expect(summary).toContain(PLACEHOLDER);
    expect(summary).toContain("Safe suffix");
    expect(summary).not.toContain(rawNeedle);
  });

  it("sanitizes post-compaction context refresh content", async () => {
    const rawNeedle = "POST_COMPACTION_CONTEXT_SECRET_LINE";
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wave4-post-context-"));
    fs.writeFileSync(
      path.join(workspace, "AGENTS.md"),
      `# AGENTS.md\n\n## Session Startup\n${BEGIN}\n${rawNeedle}\n${END}\n\n## Red Lines\nKeep safe.\n`,
    );
    const context = await readPostCompactionContext(workspace, {
      nowMs: 0,
      agentId: "default",
    });
    expect(context).toBeTruthy();
    expect(context).toContain(PLACEHOLDER);
    expect(context).not.toContain(rawNeedle);
  });
});
