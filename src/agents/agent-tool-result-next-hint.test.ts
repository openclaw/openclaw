import { describe, expect, it } from "vitest";
import { buildToolResultEnvelope } from "./agent-tool-result-bridge.js";
import { inferNextHint } from "./agent-tool-result-next-hint.js";

// ---------------------------------------------------------------------------
// inferNextHint — search / list patterns
// ---------------------------------------------------------------------------

describe("inferNextHint — search / list patterns", () => {
  it("returns a hint for 'web_search'", () => {
    const hint = inferNextHint("web_search");
    expect(hint).toBeDefined();
    expect(hint).toContain("IDs or tokens");
  });

  it("returns a hint for 'list_records'", () => {
    const hint = inferNextHint("list_records");
    expect(hint).toBeDefined();
    expect(hint).toContain("get or read tool");
  });

  it("returns a hint for 'lark_base_search_records'", () => {
    const hint = inferNextHint("lark_base_search_records");
    expect(hint).toBeDefined();
    expect(hint).toContain("IDs or tokens");
  });

  it("returns a hint for 'find_user'", () => {
    const hint = inferNextHint("find_user");
    expect(hint).toBeDefined();
  });

  it("returns a hint for 'query_messages'", () => {
    const hint = inferNextHint("query_messages");
    expect(hint).toBeDefined();
  });

  it("returns a hint for 'lookup_record'", () => {
    const hint = inferNextHint("lookup_record");
    expect(hint).toBeDefined();
  });

  it("returns a hint for 'LIST' (case-insensitive)", () => {
    const hint = inferNextHint("LIST");
    expect(hint).toBeDefined();
  });

  it("returns a hint for 'lark_im_list_messages'", () => {
    const hint = inferNextHint("lark_im_list_messages");
    expect(hint).toBeDefined();
    expect(hint).toContain("get or read tool");
  });

  it("returns a hint for 'drive_search'", () => {
    const hint = inferNextHint("drive_search");
    expect(hint).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// inferNextHint — create / insert patterns
// ---------------------------------------------------------------------------

describe("inferNextHint — create / insert patterns", () => {
  it("returns a hint for 'create_document'", () => {
    const hint = inferNextHint("create_document");
    expect(hint).toBeDefined();
    expect(hint).toContain("ID or token");
  });

  it("returns a hint for 'lark_doc_create'", () => {
    const hint = inferNextHint("lark_doc_create");
    expect(hint).toBeDefined();
    expect(hint).toContain("update, reference, or share");
  });

  it("returns a hint for 'insert_row'", () => {
    const hint = inferNextHint("insert_row");
    expect(hint).toBeDefined();
  });

  it("returns a hint for 'base_create_record'", () => {
    const hint = inferNextHint("base_create_record");
    expect(hint).toBeDefined();
  });

  it("returns a hint for 'CREATE' (case-insensitive)", () => {
    const hint = inferNextHint("CREATE");
    expect(hint).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// inferNextHint — no-hint patterns
// ---------------------------------------------------------------------------

describe("inferNextHint — no-hint patterns", () => {
  it("returns undefined for 'read'", () => {
    expect(inferNextHint("read")).toBeUndefined();
  });

  it("returns undefined for 'get_record'", () => {
    expect(inferNextHint("get_record")).toBeUndefined();
  });

  it("returns undefined for 'exec'", () => {
    expect(inferNextHint("exec")).toBeUndefined();
  });

  it("returns undefined for 'update_record'", () => {
    expect(inferNextHint("update_record")).toBeUndefined();
  });

  it("returns undefined for 'delete_file'", () => {
    expect(inferNextHint("delete_file")).toBeUndefined();
  });

  it("returns undefined for 'send_message'", () => {
    expect(inferNextHint("send_message")).toBeUndefined();
  });

  it("returns undefined for 'write'", () => {
    expect(inferNextHint("write")).toBeUndefined();
  });

  it("returns undefined for 'fetch'", () => {
    expect(inferNextHint("fetch")).toBeUndefined();
  });

  it("returns undefined for 'download_file'", () => {
    expect(inferNextHint("download_file")).toBeUndefined();
  });

  it("returns undefined for 'upload_file'", () => {
    expect(inferNextHint("upload_file")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inferNextHint — safety / no-throw
// ---------------------------------------------------------------------------

describe("inferNextHint — safety", () => {
  it("returns undefined for empty string without throwing", () => {
    expect(() => inferNextHint("")).not.toThrow();
    expect(inferNextHint("")).toBeUndefined();
  });

  it("handles very long tool names without throwing", () => {
    const longName = "a".repeat(10_000);
    expect(() => inferNextHint(longName)).not.toThrow();
  });

  it("handles tool names with special characters without throwing", () => {
    expect(() => inferNextHint("tool.with.dots")).not.toThrow();
    expect(() => inferNextHint("tool-with-dashes")).not.toThrow();
    expect(() => inferNextHint("tool/with/slashes")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: bridge wires next_hint from inferNextHint
// ---------------------------------------------------------------------------

describe("buildToolResultEnvelope — next_hint integration", () => {
  it("injects next_hint for a search tool success result", () => {
    const result = buildToolResultEnvelope({
      toolName: "lark_base_search_records",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "record_id: rec_abc123\nrecord_id: rec_def456",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next_hint).toBeDefined();
      expect(result.next_hint).toContain("IDs or tokens");
    }
  });

  it("injects next_hint for a list tool success result", () => {
    const result = buildToolResultEnvelope({
      toolName: "list_messages",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "message_id: om_abc\nmessage_id: om_def",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next_hint).toBeDefined();
    }
  });

  it("injects next_hint for a create tool success result", () => {
    const result = buildToolResultEnvelope({
      toolName: "create_document",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "doc_token: dox_abc123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next_hint).toBeDefined();
      expect(result.next_hint).toContain("update, reference, or share");
    }
  });

  it("does not inject next_hint for a read tool (no hint inferred)", () => {
    const result = buildToolResultEnvelope({
      toolName: "read",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "file content here",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next_hint).toBeUndefined();
    }
  });

  it("does not inject next_hint for an exec tool (no hint inferred)", () => {
    const result = buildToolResultEnvelope({
      toolName: "exec",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "exit 0",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next_hint).toBeUndefined();
    }
  });

  it("explicit nextHint overrides inferred hint", () => {
    const result = buildToolResultEnvelope({
      toolName: "lark_base_search_records",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: "results...",
      nextHint: "Custom hint from caller.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next_hint).toBe("Custom hint from caller.");
    }
  });

  it("error result has no next_hint when none inferred", () => {
    const result = buildToolResultEnvelope({
      toolName: "read",
      isToolError: true,
      isTimedOut: false,
      errorMessage: "File not found",
      outputText: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.next_hint).toBeUndefined();
    }
  });

  it("backcompat: existing callers without nextHint param still work", () => {
    // Calls without nextHint field should not throw and produce valid envelopes.
    const result = buildToolResultEnvelope({
      toolName: "memory_get",
      isToolError: false,
      isTimedOut: false,
      errorMessage: undefined,
      outputText: undefined,
    });
    expect(result.ok).toBe(true);
    // next_hint may be undefined — that's fine
    if (result.ok) {
      expect(result.summary).toBe("memory_get completed");
    }
  });
});
