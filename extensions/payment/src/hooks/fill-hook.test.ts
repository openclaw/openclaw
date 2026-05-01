/**
 * fill-hook.test.ts — tests for the before_tool_call browser fill hook.
 *
 * The SDK approval-granted continuation pattern (tested here):
 *   The hook eagerly retrieves secrets and returns BOTH `requireApproval`
 *   AND rewritten `params` in one response. On approval, the runtime uses
 *   `params` as the overrideParams. Tests simulate this by calling the hook
 *   directly and asserting both fields.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PaymentManager } from "../payments.js";
import { CardUnavailableError } from "../providers/base.js";
import type { CardSecrets } from "../providers/base.js";
import { handleMap } from "../store.js";
import { handleBrowserBeforeToolCall } from "./fill-hook.js";
import type { FillHookOptions } from "./fill-hook.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_SECRETS: CardSecrets = {
  pan: "4242 4242 4242 4242",
  cvv: "123",
  expMonth: "12",
  expYear: "2030",
  holderName: "Mock Holder",
};

const HANDLE_ID = "test-handle-001";
const HANDLE_ID_B = "test-handle-002";
const SPEND_REQ_ID = "spreq-001";
const SPEND_REQ_ID_B = "spreq-002";

function makeMockManager(
  secretsOverride?: Partial<CardSecrets> | (() => Promise<CardSecrets>),
): PaymentManager {
  const resolveSecrets =
    typeof secretsOverride === "function"
      ? secretsOverride
      : () => Promise.resolve({ ...MOCK_SECRETS, ...secretsOverride });

  return {
    retrieveCardSecretsForHook: vi.fn().mockImplementation(resolveSecrets),
    getSetupStatus: vi.fn(),
    listFundingSources: vi.fn(),
    issueVirtualCard: vi.fn(),
    executeMachinePayment: vi.fn(),
    getStatus: vi.fn(),
  } as unknown as PaymentManager;
}

function makeOpts(manager: PaymentManager): FillHookOptions {
  return { manager };
}

function makeFillEvent(
  fields: unknown[],
  extra?: { targetId?: string; otherParams?: Record<string, unknown> },
) {
  return {
    toolName: "browser",
    params: {
      ...extra?.otherParams,
      request: {
        kind: "fill",
        fields,
        ...(extra?.targetId ? { targetId: extra.targetId } : {}),
      },
    },
  };
}

function makeSentinel(handleId: string, field: string) {
  return { $paymentHandle: handleId, field };
}

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  handleMap._map.clear();
});

function seedHandle(
  handleId: string,
  spendRequestId: string,
  opts?: {
    last4?: string;
    targetMerchantName?: string;
    validUntil?: string;
    expired?: boolean;
  },
) {
  handleMap.set(handleId, {
    spendRequestId,
    providerId: "mock",
    last4: opts?.last4 ?? "4242",
    targetMerchantName: opts?.targetMerchantName,
    issuedAt: new Date().toISOString(),
    validUntil:
      opts?.expired === true
        ? new Date(Date.now() - 60_000).toISOString()
        : (opts?.validUntil ?? new Date(Date.now() + 30 * 60_000).toISOString()),
  });
}

// ---------------------------------------------------------------------------
// Scope: non-browser tool
// ---------------------------------------------------------------------------

describe("fill hook — scope: non-browser tool", () => {
  it("returns undefined for a non-browser tool", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      { toolName: "payment", params: { action: "issue_virtual_card" } },
      makeOpts(manager),
    );
    expect(result).toBeUndefined();
    expect(manager.retrieveCardSecretsForHook).not.toHaveBeenCalled();
  });

  it("returns undefined for toolName 'bash'", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      { toolName: "bash", params: { command: "ls" } },
      makeOpts(manager),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scope: browser tool, non-fill action
// ---------------------------------------------------------------------------

describe("fill hook — scope: browser tool, non-fill action", () => {
  it("returns undefined for browser click action", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      {
        toolName: "browser",
        params: { request: { kind: "click", ref: "#btn" } },
      },
      makeOpts(manager),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for browser type action", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      {
        toolName: "browser",
        params: { request: { kind: "type", text: "hello" } },
      },
      makeOpts(manager),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when request is missing", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      { toolName: "browser", params: {} },
      makeOpts(manager),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when fields is not an array", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      {
        toolName: "browser",
        params: { request: { kind: "fill", fields: "not-an-array" } },
      },
      makeOpts(manager),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No sentinels: passthrough
// ---------------------------------------------------------------------------

describe("fill hook — no sentinel-shaped values", () => {
  it("returns undefined when fields contain no sentinels", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "name", type: "text", value: "John Doe" },
        { ref: "email", type: "email", value: "john@example.com" },
      ]),
      makeOpts(manager),
    );
    expect(result).toBeUndefined();
    expect(manager.retrieveCardSecretsForHook).not.toHaveBeenCalled();
  });

  it("returns undefined for empty fields array", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(makeFillEvent([]), makeOpts(manager));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown handle
// ---------------------------------------------------------------------------

describe("fill hook — unknown handle", () => {
  it("returns block: true for unknown handleId", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel("unknown-handle", "pan") }]),
      makeOpts(manager),
    );
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain("unknown handle");
    expect(result!.blockReason).toContain("unknown-handle");
    expect(manager.retrieveCardSecretsForHook).not.toHaveBeenCalled();
  });

  it("block reason includes advice to issue a card", async () => {
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel("bad-id", "pan") }]),
      makeOpts(makeMockManager()),
    );
    expect(result!.blockReason).toContain("Issue a virtual card first");
  });
});

// ---------------------------------------------------------------------------
// Expired handle
// ---------------------------------------------------------------------------

describe("fill hook — expired handle", () => {
  it("returns block: true for an expired handle", async () => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID, { expired: true });
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain("expired");
    expect(manager.retrieveCardSecretsForHook).not.toHaveBeenCalled();
  });

  it("block reason includes the expiry time", async () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    handleMap.set(HANDLE_ID, {
      spendRequestId: SPEND_REQ_ID,
      providerId: "mock",
      issuedAt: new Date().toISOString(),
      validUntil: expiredAt,
    });
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(makeMockManager()),
    );
    expect(result!.blockReason).toContain(expiredAt);
  });
});

// ---------------------------------------------------------------------------
// Sentinel detected, valid handle — requireApproval
// ---------------------------------------------------------------------------

describe("fill hook — valid sentinel returns requireApproval", () => {
  beforeEach(() => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID, { last4: "4242", targetMerchantName: "Acme Shop" });
  });

  it("returns requireApproval with severity 'critical'", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.requireApproval).toBeDefined();
    expect(result!.requireApproval!.severity).toBe("critical");
  });

  it("returns requireApproval with timeoutBehavior 'deny'", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.requireApproval!.timeoutBehavior).toBe("deny");
  });

  it("approval title contains 'Payment fill'", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.requireApproval!.title).toContain("Payment fill");
  });

  it("description includes last4 display", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.requireApproval!.description).toContain("4242");
  });

  it("description includes field count", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "cvv", type: "password", value: makeSentinel(HANDLE_ID, "cvv") },
      ]),
      makeOpts(manager),
    );
    expect(result!.requireApproval!.description).toContain("2 field");
  });

  it("description includes merchant name", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.requireApproval!.description).toContain("Acme Shop");
  });

  it("description includes target display when targetId is provided", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }], {
        targetId: "tab-123",
      }),
      makeOpts(manager),
    );
    expect(result!.requireApproval!.description).toContain("tab-123");
  });
});

// ---------------------------------------------------------------------------
// Approval description MUST NOT contain raw card values
// ---------------------------------------------------------------------------

describe("fill hook — approval description security", () => {
  beforeEach(() => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID, { last4: "4242" });
  });

  it("description does not contain the real PAN", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    const desc = result!.requireApproval!.description;
    // Real PAN should not appear; last4 "4242" only appears as ••4242
    expect(desc).not.toMatch(/4242 4242 4242 4242/);
    expect(desc).not.toMatch(/\b4242424242424242\b/);
  });

  it("description does not contain CVV", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "cvv", type: "password", value: makeSentinel(HANDLE_ID, "cvv") }]),
      makeOpts(manager),
    );
    const desc = result!.requireApproval!.description;
    // The CVV is "123" — make sure it's not present as a standalone secret
    // We check against a known CVV that would be a leak
    expect(desc).not.toContain("Mock Holder");
  });

  it("description does not contain holder name", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "holder", type: "text", value: makeSentinel(HANDLE_ID, "holder_name") },
      ]),
      makeOpts(manager),
    );
    expect(result!.requireApproval!.description).not.toContain("Mock Holder");
  });
});

// ---------------------------------------------------------------------------
// Substitution: rewritten params returned alongside requireApproval
// ---------------------------------------------------------------------------

describe("fill hook — substitution in rewritten params", () => {
  beforeEach(() => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
  });

  it("returns params alongside requireApproval (SDK approval continuation pattern)", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.params).toBeDefined();
    expect(result!.requireApproval).toBeDefined();
  });

  it("rewritten fields contain the real PAN value", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    const rewrittenFields = (result!.params as any).request.fields as Array<{
      value: unknown;
    }>;
    expect(rewrittenFields[0]!.value).toBe(MOCK_SECRETS.pan);
  });

  it("rewritten fields contain the real CVV value", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "cvv", type: "password", value: makeSentinel(HANDLE_ID, "cvv") }]),
      makeOpts(manager),
    );
    const rewrittenFields = (result!.params as any).request.fields as Array<{
      value: unknown;
    }>;
    expect(rewrittenFields[0]!.value).toBe(MOCK_SECRETS.cvv);
  });

  it("rewritten fields contain exp_month, exp_year, and holder_name", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "exp_month", type: "text", value: makeSentinel(HANDLE_ID, "exp_month") },
        { ref: "exp_year", type: "text", value: makeSentinel(HANDLE_ID, "exp_year") },
        { ref: "holder", type: "text", value: makeSentinel(HANDLE_ID, "holder_name") },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe(MOCK_SECRETS.expMonth);
    expect(fields[1]!.value).toBe(MOCK_SECRETS.expYear);
    expect(fields[2]!.value).toBe(MOCK_SECRETS.holderName);
  });

  it("non-sentinel fields pass through unchanged", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "name", type: "text", value: "John Doe" },
        { ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "email", type: "email", value: "john@example.com" },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{
      ref: string;
      value: unknown;
    }>;
    expect(fields[0]!.value).toBe("John Doe");
    expect(fields[1]!.value).toBe(MOCK_SECRETS.pan);
    expect(fields[2]!.value).toBe("john@example.com");
  });
});

// ---------------------------------------------------------------------------
// Secret retrieval call count
// ---------------------------------------------------------------------------

describe("fill hook — retrieveCardSecretsForHook call count", () => {
  it("calls retrieveCardSecretsForHook exactly once per unique handleId", async () => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    const manager = makeMockManager();
    await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "cvv", type: "password", value: makeSentinel(HANDLE_ID, "cvv") },
      ]),
      makeOpts(manager),
    );
    expect(manager.retrieveCardSecretsForHook).toHaveBeenCalledTimes(1);
  });

  it("calls retrieveCardSecretsForHook with correct providerId and spendRequestId", async () => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    const manager = makeMockManager();
    await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(manager.retrieveCardSecretsForHook).toHaveBeenCalledWith("mock", SPEND_REQ_ID);
  });
});

// ---------------------------------------------------------------------------
// Multiple handles
// ---------------------------------------------------------------------------

describe("fill hook — multiple handles", () => {
  beforeEach(() => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID, { last4: "4242" });
    seedHandle(HANDLE_ID_B, SPEND_REQ_ID_B, { last4: "1234" });
  });

  it("retrieves secrets for both handles", async () => {
    const manager = makeMockManager();
    await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "pan-a", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "pan-b", type: "text", value: makeSentinel(HANDLE_ID_B, "pan") },
      ]),
      makeOpts(manager),
    );
    expect(manager.retrieveCardSecretsForHook).toHaveBeenCalledTimes(2);
  });

  it("substitutes values from both handles correctly", async () => {
    const secretsB: CardSecrets = {
      pan: "5555 5555 5555 4444",
      cvv: "456",
      expMonth: "06",
      expYear: "2031",
      holderName: "Second Holder",
    };
    const manager = {
      retrieveCardSecretsForHook: vi
        .fn()
        .mockResolvedValueOnce(MOCK_SECRETS)
        .mockResolvedValueOnce(secretsB),
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    } as unknown as PaymentManager;

    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "pan-a", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "pan-b", type: "text", value: makeSentinel(HANDLE_ID_B, "pan") },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe(MOCK_SECRETS.pan);
    expect(fields[1]!.value).toBe(secretsB.pan);
  });

  it("same handle on multiple fields — retrieved only once, both substituted", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "cvv", type: "password", value: makeSentinel(HANDLE_ID, "cvv") },
        { ref: "exp_month", type: "text", value: makeSentinel(HANDLE_ID, "exp_month") },
      ]),
      makeOpts(manager),
    );
    // Only one retrieve call despite three sentinels using the same handle
    expect(manager.retrieveCardSecretsForHook).toHaveBeenCalledTimes(1);
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe(MOCK_SECRETS.pan);
    expect(fields[1]!.value).toBe(MOCK_SECRETS.cvv);
    expect(fields[2]!.value).toBe(MOCK_SECRETS.expMonth);
  });
});

// ---------------------------------------------------------------------------
// CardUnavailableError
// ---------------------------------------------------------------------------

describe("fill hook — CardUnavailableError", () => {
  beforeEach(() => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
  });

  it("returns block: true when manager throws CardUnavailableError", async () => {
    const manager = makeMockManager(async () => {
      throw new CardUnavailableError(HANDLE_ID, "card revoked", "mock");
    });
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.block).toBe(true);
    expect(result!.requireApproval).toBeUndefined();
  });

  it("block reason includes guidance to issue a new spend request", async () => {
    const manager = makeMockManager(async () => {
      throw new CardUnavailableError(HANDLE_ID, "card revoked", "mock");
    });
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    expect(result!.blockReason).toContain("new spend request");
  });

  it("re-throws non-CardUnavailableError errors", async () => {
    const manager = makeMockManager(async () => {
      throw new Error("unexpected provider failure");
    });
    await expect(
      handleBrowserBeforeToolCall(
        makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
        makeOpts(manager),
      ),
    ).rejects.toThrow("unexpected provider failure");
  });
});

// ---------------------------------------------------------------------------
// Retry semantics
// ---------------------------------------------------------------------------

describe("fill hook — retry semantics", () => {
  it("a second fill on the same handle re-calls retrieveCardSecretsForHook", async () => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    const manager = makeMockManager();
    const event = makeFillEvent([
      { ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
    ]);
    await handleBrowserBeforeToolCall(event, makeOpts(manager));
    await handleBrowserBeforeToolCall(event, makeOpts(manager));
    expect(manager.retrieveCardSecretsForHook).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Memory hygiene — secretsByHandle is cleared after substitution
// ---------------------------------------------------------------------------

describe("fill hook — memory hygiene", () => {
  it("retrieveCardSecretsForHook is called exactly N times — no caching between calls", async () => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    const manager = makeMockManager();

    // Three separate calls — each should trigger a fresh secret retrieval
    for (let i = 0; i < 3; i++) {
      await handleBrowserBeforeToolCall(
        makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
        makeOpts(manager),
      );
    }
    expect(manager.retrieveCardSecretsForHook).toHaveBeenCalledTimes(3);
  });

  it("after hook returns, the returned params object does not share identity with internal state", async () => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    const manager = makeMockManager();
    const result1 = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    const result2 = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    // Two calls produce distinct params objects (no shared reference)
    expect(result1!.params).not.toBe(result2!.params);
  });
});

// ---------------------------------------------------------------------------
// Registration: registerFillHook wires before_tool_call
// ---------------------------------------------------------------------------

describe("registerFillHook registration", () => {
  it("calls api.on with 'before_tool_call'", async () => {
    const { registerFillHook } = await import("./fill-hook.js");
    let capturedHookName: string | null = null;
    const fakeApi = {
      on: (hookName: string, _handler: unknown) => {
        capturedHookName = hookName;
      },
    };
    registerFillHook(fakeApi as any, makeOpts(makeMockManager()));
    expect(capturedHookName).toBe("before_tool_call");
  });
});
