import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeEnvelopeSummary } from "./envelope-writer.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "creel-context-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("writeEnvelopeSummary", () => {
  it("writes the consumer-facing fields the Python scope filter reads", async () => {
    const path = join(workDir, "state", "envelope-summary.json");
    await writeEnvelopeSummary({
      path,
      envelope: {
        sender_role: "owner",
        is_owner: true,
        context_type: "dm",
        channel: "whatsapp",
        handle: "+15551234",
        session_key: "agent:main:main",
        user_id: "u-1",
        handle_display: "+15551234",
        resolved_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    // Required surface for search_context.py:allowed_scopes:
    expect(parsed.sender_role).toBe("owner");
    expect(parsed.is_owner).toBe(true);
    expect(parsed.context_type).toBe("dm");
    expect(parsed.owner_dm_unlock_for_turn).toBe(false);
    // Diagnostic _meta block — useful on-call but ignored by the consumer.
    expect(parsed._meta.channel).toBe("whatsapp");
    expect(parsed._meta.handle).toBe("+15551234");
    expect(parsed._meta.session_key).toBe("agent:main:main");
    expect(parsed._meta.user_id).toBe("u-1");
    expect(parsed._meta.resolved_at).toBe("2026-04-26T00:00:00.000Z");
  });

  it("creates the parent directory if it does not exist", async () => {
    const path = join(workDir, "deeply", "nested", "envelope-summary.json");
    await writeEnvelopeSummary({
      path,
      envelope: {
        sender_role: "stranger",
        is_owner: false,
        context_type: "dm",
        resolved_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.sender_role).toBe("stranger");
  });

  it("propagates owner_dm_unlock_for_turn=true when set", async () => {
    const path = join(workDir, "envelope-summary.json");
    await writeEnvelopeSummary({
      path,
      envelope: {
        sender_role: "owner",
        is_owner: true,
        context_type: "group",
        owner_dm_unlock_for_turn: true,
        resolved_at: "2026-04-26T00:00:00.000Z",
      },
    });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.owner_dm_unlock_for_turn).toBe(true);
  });
});
