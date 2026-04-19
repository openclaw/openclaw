import { describe, expect, it } from "vitest";
import {
  buildToolResultSummaryText,
  buildToolSummaryText,
  DEFAULT_TOOL_RESULT_MAX_LEN,
  DEFAULT_TOOL_SUMMARY_MAX_LEN,
  isSubagentPersistToolFragmentsEnabled,
  REDACT_TOKEN,
  redactToolFragment,
} from "./subagent-tool-redact.js";

describe("redactToolFragment", () => {
  it("returns empty string for empty input", () => {
    expect(redactToolFragment("", 200)).toBe("");
    expect(redactToolFragment("", 10)).toBe("");
  });

  it("returns plain text unchanged when no rules match and under maxLen", () => {
    expect(redactToolFragment("hello world", 200)).toBe("hello world");
  });

  it("truncates long output with ellipsis", () => {
    const input = "x".repeat(500);
    const out = redactToolFragment(input, 10);
    expect(out).toBe("xxxxxxxxxx…");
  });

  it("redacts Authorization header (case-insensitive)", () => {
    const input = "GET /v1/chat\nauthorization: sk-abcdef123456\naccept: */*";
    const out = redactToolFragment(input, 200);
    expect(out).toContain(`Authorization: ${REDACT_TOKEN}`);
    expect(out).not.toContain("sk-abcdef123456");
  });

  it("redacts Bearer tokens", () => {
    const out = redactToolFragment("Authorization: Bearer eyJabc.def.ghi", 200);
    // First rule masks the whole "Authorization: ..." line.
    expect(out).toContain(REDACT_TOKEN);
    expect(out).not.toContain("eyJabc.def.ghi");
  });

  it("redacts Bearer tokens outside of Authorization header", () => {
    const out = redactToolFragment("X-Upstream: Bearer secret-xyz-123", 200);
    expect(out).toContain(`Bearer ${REDACT_TOKEN}`);
    expect(out).not.toContain("secret-xyz-123");
  });

  it("redacts api_key / api-key / apikey / token / password / secret / passwd", () => {
    const inputs = [
      "api_key=abc123",
      "api-key=abc123",
      "apikey=abc123",
      'token: "abc123xyz"',
      "password: hunter2!",
      'secret="topsecret"',
      "passwd=abc",
    ];
    for (const input of inputs) {
      const out = redactToolFragment(input, 200);
      expect(out, `input=${input}`).not.toContain("abc123");
      expect(out, `input=${input}`).not.toContain("hunter2!");
      expect(out, `input=${input}`).not.toContain("topsecret");
      expect(out, `input=${input}`).toContain(REDACT_TOKEN);
    }
  });

  it("preserves the key name in api_key style rules", () => {
    const out = redactToolFragment("api_key=abc123xyz", 200);
    expect(out.toLowerCase()).toContain("api_key");
  });

  it("redacts PEM / SSH private key blobs", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIICXAIBAAKBgQDabc...deadbeef",
      "moreblob",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const input = `prelude\n${pem}\npost`;
    const out = redactToolFragment(input, 800);
    expect(out).toContain(REDACT_TOKEN);
    expect(out).not.toContain("deadbeef");
  });

  it("redacts Set-Cookie and Cookie headers", () => {
    const out1 = redactToolFragment("Set-Cookie: session=abc123; Path=/", 200);
    expect(out1).toContain(`Set-Cookie: ${REDACT_TOKEN}`);
    expect(out1).not.toContain("abc123");

    const out2 = redactToolFragment("Cookie: session=xyz789", 200);
    expect(out2).toContain(`Cookie: ${REDACT_TOKEN}`);
    expect(out2).not.toContain("xyz789");
  });

  it("redacts OpenSSH public key lines", () => {
    const out = redactToolFragment("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcde user@host", 200);
    expect(out).toContain(REDACT_TOKEN);
    expect(out).not.toContain("AAAAC3NzaC1lZDI1NTE5AAAAIabcde");
  });
});

describe("buildToolSummaryText", () => {
  it("builds a [tool: name] prefix with JSON-stringified input", () => {
    const out = buildToolSummaryText("Bash", { command: "ls" });
    expect(out.startsWith("[tool: Bash] ")).toBe(true);
    expect(out).toContain('"command":"ls"');
  });

  it("redacts sensitive fields inside input", () => {
    const out = buildToolSummaryText("WebFetch", { url: "https://x", api_key: "abc123" });
    expect(out).not.toContain("abc123");
    expect(out).toContain(REDACT_TOKEN);
  });

  it("respects the default 200-char cap", () => {
    const longValue = "x".repeat(1000);
    const out = buildToolSummaryText("X", { blob: longValue });
    expect(out.length).toBeLessThanOrEqual("[tool: X] ".length + DEFAULT_TOOL_SUMMARY_MAX_LEN + 1);
  });
});

describe("buildToolResultSummaryText", () => {
  it("prefixes with [result]", () => {
    expect(buildToolResultSummaryText("ok")).toBe("[result] ok");
  });

  it("redacts credentials in results", () => {
    const out = buildToolResultSummaryText("Authorization: Bearer sk-secret-abc\n200 OK");
    expect(out).not.toContain("sk-secret-abc");
    expect(out).toContain(REDACT_TOKEN);
  });

  it("caps at 500 chars", () => {
    const huge = "z".repeat(2000);
    const out = buildToolResultSummaryText(huge);
    expect(out.length).toBeLessThanOrEqual("[result] ".length + DEFAULT_TOOL_RESULT_MAX_LEN + 1);
  });

  it("handles nullish input safely", () => {
    expect(buildToolResultSummaryText(undefined)).toBe("[result]");
    expect(buildToolResultSummaryText(null)).toBe("[result]");
  });
});

describe("isSubagentPersistToolFragmentsEnabled", () => {
  it("is on by default when env is missing", () => {
    expect(isSubagentPersistToolFragmentsEnabled({})).toBe(true);
  });

  it("is off for 0 / false / off / no", () => {
    expect(isSubagentPersistToolFragmentsEnabled({ SUBAGENT_PERSIST_TOOL_FRAGMENTS: "0" })).toBe(
      false,
    );
    expect(
      isSubagentPersistToolFragmentsEnabled({ SUBAGENT_PERSIST_TOOL_FRAGMENTS: "false" }),
    ).toBe(false);
    expect(isSubagentPersistToolFragmentsEnabled({ SUBAGENT_PERSIST_TOOL_FRAGMENTS: "OFF" })).toBe(
      false,
    );
    expect(isSubagentPersistToolFragmentsEnabled({ SUBAGENT_PERSIST_TOOL_FRAGMENTS: "no" })).toBe(
      false,
    );
  });

  it("is on for 1 / true / on / yes / empty string", () => {
    expect(isSubagentPersistToolFragmentsEnabled({ SUBAGENT_PERSIST_TOOL_FRAGMENTS: "1" })).toBe(
      true,
    );
    expect(isSubagentPersistToolFragmentsEnabled({ SUBAGENT_PERSIST_TOOL_FRAGMENTS: "true" })).toBe(
      true,
    );
    expect(isSubagentPersistToolFragmentsEnabled({ SUBAGENT_PERSIST_TOOL_FRAGMENTS: "" })).toBe(
      true,
    );
  });
});
