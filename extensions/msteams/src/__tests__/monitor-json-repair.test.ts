/**
 * Regression test for:
 *   SyntaxError: Bad escaped character in JSON at position N
 *
 * Some Bot Framework clients (e.g. certain MS Teams clients) send activity
 * payloads that contain invalid JSON escape sequences such as bare backslashes
 * followed by characters not defined in RFC 8259 (e.g. \p, \q, \c).
 *
 * The previous `express.json()` strict parser threw SyntaxError on such payloads,
 * causing non-200 responses → Azure Bot Service exponential backoff → messages dropped.
 *
 * This test suite verifies the two-pass JSON repair middleware introduced in monitor.ts.
 */

import { describe, it, expect } from "vitest";

/** Mirrors the repair regex from monitor.ts middleware */
const REPAIR_REGEX = /\\([^"\\\//bfnrtu])/g;

/** Emulates the two-pass parse logic from the fixed middleware */
function twoPassParse(raw: string): { body: unknown; path: "first_pass" | "repaired" } {
  try {
    return { body: JSON.parse(raw), path: "first_pass" };
  } catch {
    const fixed = raw.replace(REPAIR_REGEX, "\\\\$1");
    return { body: JSON.parse(fixed), path: "repaired" }; // throws if still invalid
  }
}

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

/** conversationUpdate payload with bare \p inside a JSON string — invalid per RFC 8259 */
const BAD_ESCAPE_PAYLOAD = String.raw`{
  "type": "conversationUpdate",
  "timestamp": "2026-03-04T14:19:17.000Z",
  "id": "f:abc123",
  "channelId": "msteams",
  "serviceUrl": "https://smba.trafficmanager.net/apac/",
  "from": {"id": "29:xxx", "name": "User"},
  "conversation": {"id": "19:meeting_abc@thread.v2", "tenantId": "tenant-id"},
  "recipient": {"id": "28:bot-id", "name": "Bot"},
  "membersAdded": [{"id": "28:bot-id", "name": "Bot"}],
  "channelData": {
    "tenant": {"id": "tenant-id"},
    "eventType": "teamMemberAdded",
    "team": {"id": "19:meeting\participant_abc@thread.v2", "name": "Test\Project"}
  }
}`;

/** Well-formed message activity — must parse on first pass unchanged */
const GOOD_MESSAGE_PAYLOAD = JSON.stringify({
  type: "message",
  text: "Hello",
  from: { id: "29:user", name: "User" },
  conversation: { id: "19:channel@thread.v2" },
  // Windows paths with proper double-backslash — already valid JSON
  channelData: { path: "C:\\Users\\test" },
});

/** Payload with valid JSON escape sequences — must NOT be double-escaped */
const VALID_ESCAPES_PAYLOAD = String.raw`{"text": "line1\nline2\ttab\"quote\\backslash"}`;

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe("msteams JSON repair middleware", () => {
  it("standard JSON.parse() throws SyntaxError on bad escape sequences", () => {
    // This proves the original express.json() would fail
    expect(() => JSON.parse(BAD_ESCAPE_PAYLOAD)).toThrow(SyntaxError);
  });

  it("two-pass repair recovers activities with bare backslash escape sequences", () => {
    const { body, path } = twoPassParse(BAD_ESCAPE_PAYLOAD);
    expect(path).toBe("repaired");
    const activity = body as Record<string, unknown>;
    expect(activity["type"]).toBe("conversationUpdate");
    // After repair \p → \\p in JSON → literal backslash + p in the parsed string
    const channelData = activity["channelData"] as Record<string, unknown>;
    const team = channelData["team"] as Record<string, unknown>;
    expect(team["name"]).toBe("Test\\Project");
  });

  it("well-formed message payloads pass through on the first parse (no repair)", () => {
    const { body, path } = twoPassParse(GOOD_MESSAGE_PAYLOAD);
    expect(path).toBe("first_pass");
    const activity = body as Record<string, unknown>;
    expect(activity["text"]).toBe("Hello");
  });

  it("valid JSON escape sequences (\\n \\t \\\\ etc.) are preserved and not double-escaped", () => {
    const { body, path } = twoPassParse(VALID_ESCAPES_PAYLOAD);
    expect(path).toBe("first_pass"); // No repair needed for valid JSON
    const obj = body as Record<string, string>;
    expect(obj["text"]).toBe("line1\nline2\ttab\"quote\\backslash");
  });

  it("completely malformed JSON is re-thrown (caller returns HTTP 200 to prevent backoff)", () => {
    const garbage = "{ not valid json at all ??? }";
    expect(() => twoPassParse(garbage)).toThrow(SyntaxError);
  });
});
