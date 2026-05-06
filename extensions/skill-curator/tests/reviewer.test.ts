import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReviewManifest,
  parseReviewResponse,
  validatePatchAction,
  CURATOR_SYSTEM_PROMPT,
} from "../src/reviewer.js";
import { loadUsage, saveUsage, stampAgentCreated } from "../src/telemetry.js";
import type { UsageFile } from "../src/telemetry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-curator-review-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildReviewManifest", () => {
  it("includes only agent-created, non-pinned, non-archived skills", async () => {
    const dir = await makeTempDir();
    const usage: UsageFile = {
      version: 1,
      skills: {
        "agent-active": {
          name: "agent-active",
          view_count: 3,
          use_count: 2,
          patch_count: 0,
          last_viewed_at: null,
          last_used_at: "2026-05-01T00:00:00.000Z",
          last_patched_at: null,
          pinned: false,
          created_at: "2026-01-01T00:00:00.000Z",
          created_by: "agent",
          created_at_ms: 1700000000000,
          source: "agent-created",
          state: "active",
        },
        "agent-pinned": {
          name: "agent-pinned",
          view_count: 5,
          use_count: 10,
          patch_count: 0,
          last_viewed_at: null,
          last_used_at: "2026-05-05T00:00:00.000Z",
          last_patched_at: null,
          pinned: true,
          created_at: "2026-01-01T00:00:00.000Z",
          created_by: "agent",
          created_at_ms: 1700000000000,
          source: "agent-created",
          state: "active",
        },
        "user-skill": {
          name: "user-skill",
          view_count: 1,
          use_count: 1,
          patch_count: 0,
          last_viewed_at: null,
          last_used_at: "2026-01-01T00:00:00.000Z",
          last_patched_at: null,
          pinned: false,
          created_at: "2026-01-01T00:00:00.000Z",
          created_by: "user",
          created_at_ms: null,
          source: "agent-created",
          state: "active",
        },
        "bundled-skill": {
          name: "bundled-skill",
          view_count: 0,
          use_count: 0,
          patch_count: 0,
          last_viewed_at: null,
          last_used_at: null,
          last_patched_at: null,
          pinned: false,
          created_at: "2026-01-01T00:00:00.000Z",
          created_by: "agent",
          created_at_ms: 1700000000000,
          source: "bundled",
          state: "active",
        },
        "agent-archived": {
          name: "agent-archived",
          view_count: 0,
          use_count: 0,
          patch_count: 0,
          last_viewed_at: null,
          last_used_at: null,
          last_patched_at: null,
          pinned: false,
          created_at: "2026-01-01T00:00:00.000Z",
          created_by: "agent",
          created_at_ms: 1700000000000,
          source: "agent-created",
          state: "archived",
        },
      },
      updated_at: "2026-05-06T12:00:00.000Z",
      last_run_at: null,
      paused: false,
    };
    await saveUsage(dir, usage);

    const manifest = await buildReviewManifest(dir);
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0].name).toBe("agent-active");
  });

  it("returns empty manifest for no agent-created skills", async () => {
    const dir = await makeTempDir();
    const manifest = await buildReviewManifest(dir);
    expect(manifest.skills).toHaveLength(0);
  });
});

describe("parseReviewResponse", () => {
  it("parses valid keep decision", () => {
    const result = parseReviewResponse(JSON.stringify({ decisions: [{ action: "keep" }] }));
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toEqual({ action: "keep" });
  });

  it("parses valid patch decision", () => {
    const result = parseReviewResponse(
      JSON.stringify({
        decisions: [{ action: "patch", old_string: "Use port 3000", new_string: "Use port 8080" }],
      }),
    );
    expect(result.decisions[0]).toEqual({
      action: "patch",
      old_string: "Use port 3000",
      new_string: "Use port 8080",
    });
  });

  it("parses valid archive decision", () => {
    const result = parseReviewResponse(
      JSON.stringify({
        decisions: [{ action: "archive", reason: "No longer needed" }],
      }),
    );
    expect(result.decisions[0]).toEqual({ action: "archive", reason: "No longer needed" });
  });

  it("parses valid consolidate decision", () => {
    const result = parseReviewResponse(
      JSON.stringify({
        decisions: [
          {
            action: "consolidate",
            merge_target: "git-workflow",
            new_content: "# Combined\n\nContent here\n",
          },
        ],
      }),
    );
    expect(result.decisions[0]).toEqual({
      action: "consolidate",
      merge_target: "git-workflow",
      new_content: "# Combined\n\nContent here\n",
    });
  });

  it("rejects non-JSON input", () => {
    expect(() => parseReviewResponse("not json")).toThrow("Failed to parse");
  });

  it("rejects missing decisions array", () => {
    expect(() => parseReviewResponse(JSON.stringify({}))).toThrow("missing 'decisions'");
  });

  it("rejects invalid action name", () => {
    expect(() =>
      parseReviewResponse(JSON.stringify({ decisions: [{ action: "delete_all" }] })),
    ).toThrow("invalid action");
  });

  it("rejects patch without old_string", () => {
    expect(() =>
      parseReviewResponse(JSON.stringify({ decisions: [{ action: "patch", new_string: "x" }] })),
    ).toThrow("patch requires old_string");
  });

  it("rejects patch where old_string equals new_string", () => {
    expect(() =>
      parseReviewResponse(
        JSON.stringify({
          decisions: [{ action: "patch", old_string: "same", new_string: "same" }],
        }),
      ),
    ).toThrow("must differ");
  });

  it("rejects path traversal in patch", () => {
    expect(() =>
      parseReviewResponse(
        JSON.stringify({
          decisions: [{ action: "patch", old_string: "../secrets", new_string: "ok" }],
        }),
      ),
    ).toThrow("path traversal");
  });

  it("rejects path traversal in consolidate merge_target", () => {
    expect(() =>
      parseReviewResponse(
        JSON.stringify({
          decisions: [
            {
              action: "consolidate",
              merge_target: "../../etc/passwd",
              new_content: "bad",
            },
          ],
        }),
      ),
    ).toThrow("path traversal");
  });

  it("handles archive without reason (defaults)", () => {
    const result = parseReviewResponse(JSON.stringify({ decisions: [{ action: "archive" }] }));
    expect(result.decisions[0]).toEqual({ action: "archive", reason: "No reason provided" });
  });
});

describe("validatePatchAction", () => {
  it("accepts single match", () => {
    const result = validatePatchAction("Hello world", "world", "my-skill");
    expect(result.valid).toBe(true);
  });

  it("rejects zero matches", () => {
    const result = validatePatchAction("Hello world", "missing", "my-skill");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects multiple matches", () => {
    const result = validatePatchAction("foo bar foo", "foo", "my-skill");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("matches 2 times");
  });

  it("rejects path traversal in skill name", () => {
    const result = validatePatchAction("content", "content", "../bad");
    expect((result as { valid: false; error: string }).error).toContain("traversal");
    expect(result.valid).toBe(false);
  });

  it("rejects .archive reference in skill name", () => {
    const result = validatePatchAction("content", "content", ".archive/skill");
    expect(result.valid).toBe(false);
    expect(result.error).toContain(".archive");
  });

  it("rejects hidden directory skill names", () => {
    const result = validatePatchAction("content", "content", ".hidden-skill");
    expect(result.valid).toBe(false);
  });
});

describe("system prompt", () => {
  it("contains key curator instructions", () => {
    expect(CURATOR_SYSTEM_PROMPT).toContain("keep");
    expect(CURATOR_SYSTEM_PROMPT).toContain("patch");
    expect(CURATOR_SYSTEM_PROMPT).toContain("consolidate");
    expect(CURATOR_SYSTEM_PROMPT).toContain("archive");
    expect(CURATOR_SYSTEM_PROMPT).toContain("decisions");
  });
});
