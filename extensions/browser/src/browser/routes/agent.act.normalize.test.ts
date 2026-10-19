import { describe, expect, it } from "vitest";
import { ACT_MAX_BATCH_DEPTH } from "../act-policy.js";
import { canonicalizeActTargetIds, normalizeActRequest } from "./agent.act.normalize.js";

const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;

function rejects(body: Record<string, unknown>, message: string) {
  expect(() => normalizeActRequest(body)).toThrow(message);
}

it("projects nested actions without leaking caller control fields or dropping false and empty values", () => {
  expect(
    normalizeActRequest({
      kind: "batch",
      targetId: 123,
      stopOnError: false,
      signal: "caller-signal",
      actions: [
        {
          kind: "click",
          ref: " e1 ",
          doubleClick: false,
          delayMs: 0,
          resolvedPage: { targetId: "other-page" },
          assertCurrent: "caller-authority",
        },
        { kind: "type", selector: " input ", text: "", submit: false, slowly: false },
        { kind: "select", ref: "e2", values: ["", " spaced "] },
        { kind: "close", timeoutMs: "ignored-for-close" },
      ],
    }),
  ).toStrictEqual({
    kind: "batch",
    targetId: "123",
    stopOnError: false,
    actions: [
      { kind: "click", ref: "e1", doubleClick: false, delayMs: 0 },
      { kind: "type", selector: "input", text: "", submit: false, slowly: false },
      { kind: "select", ref: "e2", values: ["", " spaced "] },
      { kind: "close" },
    ],
  });
});

describe("canonicalizeActTargetIds", () => {
  const canonical = "abcd1234";
  const tab = { targetId: canonical, suggestedTargetId: "sg-1", tabId: "tab-7", label: "Inbox" };

  it("rewrites every same-tab alias to the canonical targetId before dispatch", () => {
    for (const alias of ["abcd", "tab-7", "Inbox", "sg-1", canonical]) {
      const action = { kind: "click", ref: "1", targetId: alias } as const;
      expect(canonicalizeActTargetIds(action, tab)).toBeNull();
      expect(action.targetId).toBe(canonical);
    }
  });

  it("canonicalizes batch sub-action aliases recursively", () => {
    const action = {
      kind: "batch",
      targetId: "abcd",
      actions: [
        { kind: "click", ref: "1", targetId: "tab-7" },
        { kind: "batch", actions: [{ kind: "resize", width: 2, height: 2, targetId: "Inbox" }] },
      ],
    } satisfies Parameters<typeof canonicalizeActTargetIds>[0];
    expect(canonicalizeActTargetIds(action, tab, [tab])).toBeNull();
    expect(action).toMatchObject({
      targetId: canonical,
      actions: [{ targetId: canonical }, { kind: "batch", actions: [{ targetId: canonical }] }],
    });
  });

  it("rejects ids that resolve to a different tab", () => {
    expect(canonicalizeActTargetIds({ kind: "click", ref: "1", targetId: "zzzz9999" }, tab)).toBe(
      "action targetId must match request targetId",
    );
    expect(
      canonicalizeActTargetIds(
        { kind: "batch", actions: [{ kind: "click", ref: "1", targetId: "zzzz9999" }] },
        tab,
      ),
    ).toBe("batched action targetId must match request targetId");
  });

  it("rejects a batched targetId prefix that is ambiguous across tabs", () => {
    expect(
      canonicalizeActTargetIds(
        { kind: "batch", actions: [{ kind: "click", ref: "1", targetId: "abcd" }] },
        tab,
        [tab, { targetId: "abcd9999" }],
      ),
    ).toBe("batched action targetId must match request targetId");
  });
});

describe("normalizeActRequest keyboard keys", () => {
  it("preserves focused text insertion without an element ref", () => {
    const text = "  pasted 🦞\nsecond line  ";
    expect(normalizeActRequest({ kind: "insertText", text, targetId: "tab-1" })).toEqual({
      kind: "insertText",
      text,
      targetId: "tab-1",
    });
  });

  it("rejects non-text insertion payloads without echoing content", () => {
    rejects({ kind: "insertText", text: { secret: "synthetic" } }, "insertText requires text");
  });

  it.each([
    ["Ctrl+Shift+Esc", "Control+Shift+Escape"],
    [" ", "Space"],
    [" + ", "+"],
    ["__proto__", "__proto__"],
  ])("normalizes keyboard input %j", (key, expected) => {
    expect(normalizeActRequest({ kind: "press", key })).toMatchObject({ key: expected });
  });

  it("still rejects an empty press key after trimming", () => {
    rejects({ kind: "press", key: "" }, "press requires key");
    rejects({ kind: "press", key: "\t" }, "press requires key");
  });
});

describe("normalizeActRequest numeric fields", () => {
  it.each([
    {
      name: "decimal integer strings",
      request: { kind: "wait", timeMs: "25", timeoutMs: "5000" },
      expected: { kind: "wait", timeMs: 25, timeoutMs: 5000 },
    },
    {
      name: "oversized timeouts",
      request: { kind: "wait", text: "ready", timeoutMs: String(Number.MAX_SAFE_INTEGER) },
      expected: { kind: "wait", text: "ready", timeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS },
    },
  ])("normalizes $name", ({ request, expected }) => {
    expect(normalizeActRequest(request)).toMatchObject(expected);
  });

  it("rejects loose integer tokens for action durations and timeouts", () => {
    rejects(
      { kind: "click", ref: "1", delayMs: "0x10" },
      "delayMs must be a non-negative integer.",
    );
    rejects({ kind: "wait", timeMs: "1e3" }, "timeMs must be a non-negative integer.");
    rejects(
      { kind: "hover", ref: "1", timeoutMs: "1000ms" },
      "timeoutMs must be a positive integer.",
    );
  });

  it("rejects fractional viewport dimensions before dispatch", () => {
    rejects(
      { kind: "resize", width: "800.5", height: 600 },
      "resize requires positive width and height",
    );
  });
});

it("normalizeActRequest validates fill fields inside batch sub-actions", () => {
  rejects(
    {
      kind: "batch",
      actions: [{ kind: "fill", fields: [{ ref: "e1", value: "Neo", text: "unsupported" }] }],
    },
    'fields[0] unsupported field key "text"',
  );
});

describe("normalizeActRequest batch nesting depth", () => {
  const buildNestedBatch = (depth: number): Record<string, unknown> => {
    let action: Record<string, unknown> = { kind: "click", ref: "1" };
    for (let i = 0; i < depth; i += 1) {
      action = { kind: "batch", actions: [action] };
    }
    return action;
  };

  it("normalizes batches nested up to the depth limit", () => {
    const normalized = normalizeActRequest(buildNestedBatch(ACT_MAX_BATCH_DEPTH + 1));
    expect(normalized).toMatchObject({ kind: "batch" });
  });

  it("rejects nesting past the depth limit with a clear error instead of overflowing the stack", () => {
    // A ~1MB JSON body fits tens of thousands of levels; without a depth bound the
    // recursive normalization throws RangeError before the action-count check runs.
    for (const depth of [ACT_MAX_BATCH_DEPTH + 2, 30_000]) {
      expect(() => normalizeActRequest(buildNestedBatch(depth))).toThrow(
        `batch nesting exceeds maximum depth of ${ACT_MAX_BATCH_DEPTH}`,
      );
    }
  });
});

it("rejects non-action commands inside batches", () => {
  rejects(
    { kind: "batch", actions: [{ kind: "navigate", url: "https://example.com" }] },
    "kind is required",
  );
});
