import { describe, expect, it } from "vitest";
import {
  collectCompletionsRegions,
  collectResponsesRegions,
  runPromptPresenceCheck,
  type PromptPresenceExpectation,
} from "./prompt-presence-check.js";

const BODY = "产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性";

function expectation(overrides?: Partial<PromptPresenceExpectation>): PromptPresenceExpectation {
  return {
    activationId: "act_prompt_target",
    revision: 0,
    bodyText: BODY,
    bodyChars: BODY.length,
    bodyComplete: true,
    ...overrides,
  };
}

describe("prompt presence check (offline fixtures, design-example acceptance)", () => {
  it("A1 full hit: body inside the system message of a responses request", () => {
    const collected = collectResponsesRegions({
      instructions: `intro ${BODY} outro`,
      input: [{ role: "user", content: "hello" }],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.checked).toBe(true);
    expect(check.boundary).toBe("pre_submission_request_object");
    expect(check.results[0]).toMatchObject({
      activationId: "act_prompt_target",
      outcome: "full_hit",
      hitRole: "instructions",
      presentInWrongRole: false,
    });
    expect(check.results[0]?.hitMessageIndex).toBe(-1);
  });

  it("A2 checked missing: assembled claim but body absent from the request object", () => {
    const collected = collectResponsesRegions({
      instructions: "unrelated system text",
      input: [{ role: "user", content: "hello" }],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 3,
    });
    expect(check.results[0]).toMatchObject({
      outcome: "checked_missing",
      presentInWrongRole: false,
    });
    expect(check.attemptIndex).toBe(3);
  });

  it("A3 unparseable content yields unknown, never a missing verdict", () => {
    const collected = collectResponsesRegions({
      instructions: "text",
      input: [{ role: "system", content: { structured: true } }],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({ outcome: "unknown", reason: "unparseable_content" });
  });

  it("A4 revision change: judgment follows the frozen text and records the revision", () => {
    const collected = collectResponsesRegions({
      instructions: "stale body text from revision zero",
      input: [],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation({ revision: 2, bodyText: "stale body text from revision zero" })],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({
      outcome: "full_hit",
      revision: 2,
      hitRole: "instructions",
    });
  });

  it("A7 wrong role: body in user message records presentInWrongRole, not full_hit", () => {
    const collected = collectResponsesRegions({
      instructions: "unrelated",
      input: [{ role: "user", content: `echo ${BODY}` }],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({
      outcome: "checked_missing",
      presentInWrongRole: true,
    });
  });

  it("A8 PD fragment present but absent from the submitted request object", () => {
    const collected = collectResponsesRegions({
      instructions: "final request without any injected block",
      input: [],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({ outcome: "checked_missing" });
  });

  it("A6 retry: each attempt is an independent check with its own attemptIndex", () => {
    const first = collectResponsesRegions({ instructions: "no body here", input: [] });
    const second = collectResponsesRegions({ instructions: BODY, input: [] });
    const checkOne = runPromptPresenceCheck({
      collected: first,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    const checkTwo = runPromptPresenceCheck({
      collected: second,
      expectations: [expectation()],
      attemptIndex: 1,
    });
    expect(checkOne.results[0]?.outcome).toBe("checked_missing");
    expect(checkTwo.results[0]?.outcome).toBe("full_hit");
    expect(checkOne.attemptIndex).toBe(0);
    expect(checkTwo.attemptIndex).toBe(1);
  });

  it("A5 wrong-run expectations are structurally impossible: carrier binds one request", () => {
    // The carrier is options-scoped; a test asserts the checker uses exactly the
    // expectations handed to it (never reaching for run-global state).
    const collected = collectResponsesRegions({ instructions: BODY, input: [] });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation({ activationId: "act_other_run" })],
      attemptIndex: 0,
    });
    expect(check.results[0]?.activationId).toBe("act_other_run");
  });

  it("scans every legal-role message, not only the first", () => {
    const collected = collectResponsesRegions({
      instructions: "first legal text without the body",
      input: [
        { role: "system", content: "still nothing" },
        { role: "developer", content: `found ${BODY}` },
        { role: "user", content: "noise" },
      ],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({
      outcome: "full_hit",
      hitMessageIndex: 1,
      hitRole: "developer",
    });
  });

  it("scans structured input_text parts of legal-role messages", () => {
    const collected = collectResponsesRegions({
      instructions: "lead",
      input: [
        {
          role: "system",
          content: [
            { type: "input_text", text: "part one " },
            { type: "input_text", text: BODY },
            { type: "input_image", image_url: "x" },
          ],
        },
      ],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]?.outcome).toBe("full_hit");
  });

  it("never fabricates a hit by concatenating two messages (prefix split across messages)", () => {
    const half = BODY.slice(0, Math.floor(BODY.length / 2));
    const rest = BODY.slice(Math.floor(BODY.length / 2));
    const collected = collectResponsesRegions({
      instructions: half,
      input: [{ role: "system", content: rest }],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]?.outcome).toBe("checked_missing");
  });

  it("prefix-only body in the legal role stays checked_missing (no partial hits)", () => {
    const collected = collectResponsesRegions({
      instructions: BODY.slice(0, BODY.length - 3),
      input: [],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]?.outcome).toBe("checked_missing");
  });

  it("completions standard {type:'text'} parts with the full body yield full_hit", () => {
    // Defect 1 counterexample: the host cache path emits standard text parts.
    const collected = collectCompletionsRegions({
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "policy " },
            { type: "text", text: BODY },
          ],
        },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({
      outcome: "full_hit",
      hitMessageIndex: 0,
      hitRole: "system",
    });
  });

  it("completions mixed parts: text parts scanned, non-text parts ignored", () => {
    const collected = collectCompletionsRegions({
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: BODY },
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "unknown_future_part", payload: BODY },
          ],
        },
      ],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]?.outcome).toBe("full_hit");
  });

  it("responses input_text parts keep working (per-API contract, no cross-API acceptance)", () => {
    const collected = collectCompletionsRegions({
      messages: [{ role: "system", content: [{ type: "input_text", text: BODY }] }],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    // input_text is NOT a completions text part: the legal-role content is
    // unreadable under the completions contract and the target cannot be ruled
    // out, so the check degrades to unknown instead of a silent skip.
    expect(check.results[0]).toMatchObject({
      outcome: "unknown",
      reason: "unparseable_content",
    });
  });

  it("empty bodyText is invalid: unknown, never a vacuous full_hit", () => {
    const collected = collectResponsesRegions({ instructions: "anything at all", input: [] });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation({ bodyText: "", bodyChars: 0 })],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({ outcome: "unknown", reason: "invalid_body" });
  });

  it("whitespace-only bodyText is invalid too", () => {
    const collected = collectResponsesRegions({ instructions: "anything", input: [] });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation({ bodyText: "  \n\t ", bodyChars: 5 })],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({ outcome: "unknown", reason: "invalid_body" });
  });

  it("legal-role message with unreadable structured content degrades the whole check to unknown", () => {
    const collected = collectCompletionsRegions({
      messages: [
        { role: "system", content: "readable without the body" },
        { role: "system", content: { opaque: "structured" } },
        { role: "user", content: BODY },
      ],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({ outcome: "unknown", reason: "unparseable_content" });
  });

  it("body over the per-body limit is unknown, not a truncated match", () => {
    const collected = collectResponsesRegions({ instructions: "x".repeat(4096), input: [] });
    const big = expectation({
      bodyText: "y".repeat(128 * 1024),
      bodyChars: 128 * 1024,
    });
    const check = runPromptPresenceCheck({ collected, expectations: [big], attemptIndex: 0 });
    expect(check.results[0]).toMatchObject({ outcome: "unknown", reason: "body_over_limit" });
  });

  it("cumulative scan cap across legal AND wrong roles yields unknown, never checked_missing", () => {
    // Two ~20 MiB regions: individually under the 8 MiB? No — keep under per-region
    // limit by using a custom limits object so only the cumulative cap trips.
    const big = "z".repeat(20 * 1024 * 1024);
    const collected = {
      legal: [{ messageIndex: 0, role: "system", text: big }],
      other: [{ messageIndex: 1, role: "user", text: big }],
      unparseable: false,
    };
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
      limits: {
        maxExpectations: 64,
        maxBodyChars: 64 * 1024,
        maxRegionChars: 24 * 1024 * 1024,
        maxMessages: 512,
        maxCumulativeScanBytes: 32 * 1024 * 1024,
      },
    });
    expect(check.results[0]).toMatchObject({
      outcome: "unknown",
      reason: "cumulative_scan_over_limit",
    });
    expect(check.limitsExceeded?.scanBytes).toBeGreaterThan(32 * 1024 * 1024);
  });

  it("unreadable legal region downgrades missing to scan_region_over_limit", () => {
    const collected = {
      legal: [
        { messageIndex: 0, role: "system", text: "readable without body" },
        { messageIndex: 1, role: "system", text: "q".repeat(9 * 1024 * 1024) },
      ],
      other: [],
      unparseable: false,
    };
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({
      outcome: "unknown",
      reason: "scan_region_over_limit",
    });
  });

  it("owner condition 2: truncated assembly fragment never yields full_hit", () => {
    const collected = collectResponsesRegions({ instructions: BODY.slice(0, 20), input: [] });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation({ bodyComplete: false })],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({ outcome: "unknown", reason: "assembly_truncated" });
  });

  it("expectations over the count limit are unknown with the actual count", () => {
    const collected = collectResponsesRegions({ instructions: BODY, input: [] });
    const many = Array.from({ length: 65 }, (_, i) => expectation({ activationId: `act_${i}` }));
    const check = runPromptPresenceCheck({ collected, expectations: many, attemptIndex: 0 });
    expect(check.results).toHaveLength(65);
    expect(check.results[0]).toMatchObject({
      outcome: "unknown",
      reason: "expectations_over_limit",
    });
    expect(check.limitsExceeded?.expectations).toBe(65);
  });

  it("empty or absent expectations report checked=false with a reason (no silent skip)", () => {
    const collected = collectResponsesRegions({ instructions: BODY, input: [] });
    const absent = runPromptPresenceCheck({ collected, expectations: undefined, attemptIndex: 0 });
    expect(absent.checked).toBe(false);
    expect(absent.reason).toBe("missing_expectations");
    const empty = runPromptPresenceCheck({ collected, expectations: [], attemptIndex: 0 });
    expect(empty.checked).toBe(false);
    expect(empty.reason).toBe("missing_expectations");
  });

  it("completions regions: system roles are legal, user/assistant/tool are wrong-role", () => {
    const collected = collectCompletionsRegions({
      messages: [
        { role: "system", content: `policy ${BODY}` },
        { role: "user", content: BODY },
        { role: "assistant", content: "reply" },
        { role: "tool", content: BODY },
      ],
    });
    const check = runPromptPresenceCheck({
      collected,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({
      outcome: "full_hit",
      hitMessageIndex: 0,
      hitRole: "system",
    });
  });

  it("checker exceptions become unknown:check_failed and never throw", () => {
    const poisoned = {
      legal: null,
      other: null,
      unparseable: false,
    } as unknown as ReturnType<typeof collectResponsesRegions>;
    const check = runPromptPresenceCheck({
      collected: poisoned,
      expectations: [expectation()],
      attemptIndex: 0,
    });
    expect(check.results[0]).toMatchObject({ outcome: "unknown", reason: "check_failed" });
    expect(check.checkFailedReason).toContain("exception");
  });
});
