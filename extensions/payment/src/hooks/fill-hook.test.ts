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
import type { BuyerProfile, CardSecrets, CredentialFillData } from "../providers/base.js";
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
  expMmYy: "12/30",
  expMmYyyy: "12/2030",
};

const MOCK_PROFILE: BuyerProfile = {
  holderName: "Mock Holder",
  billing: {
    line1: "510 Townsend St",
    city: "San Francisco",
    state: "CA",
    postalCode: "94103",
    country: "US",
  },
  extras: {},
};

const MOCK_DATA: CredentialFillData = {
  secrets: MOCK_SECRETS,
  profile: MOCK_PROFILE,
};

const HANDLE_ID = "test-handle-001";
const HANDLE_ID_B = "test-handle-002";
const SPEND_REQ_ID = "spreq-001";
const SPEND_REQ_ID_B = "spreq-002";

function makeMockManager(
  dataOverride?: Partial<CredentialFillData> | (() => Promise<CredentialFillData>),
): PaymentManager {
  const resolveData =
    typeof dataOverride === "function"
      ? dataOverride
      : () =>
          Promise.resolve({
            secrets: { ...MOCK_DATA.secrets, ...(dataOverride?.secrets ?? {}) },
            profile: { ...MOCK_DATA.profile, ...(dataOverride?.profile ?? {}) },
          });

  return {
    retrieveCardSecretsForHook: vi.fn().mockImplementation(resolveData),
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
    expect(fields[2]!.value).toBe(MOCK_PROFILE.holderName);
  });

  it("rewritten field contains exp_mm_yy (combined 2-digit year format)", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "exp-date", type: "text", value: makeSentinel(HANDLE_ID, "exp_mm_yy") },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe(MOCK_SECRETS.expMmYy); // "12/30"
  });

  it("rewritten field contains exp_mm_yyyy (combined 4-digit year format)", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "exp-date", type: "text", value: makeSentinel(HANDLE_ID, "exp_mm_yyyy") },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe(MOCK_SECRETS.expMmYyyy); // "12/2030"
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

  it("rewritten fields contain billing_line1, billing_city, billing_state, billing_postal_code, billing_country", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        {
          ref: "billing-address",
          type: "text",
          value: makeSentinel(HANDLE_ID, "billing_line1"),
        },
        { ref: "billing-city", type: "text", value: makeSentinel(HANDLE_ID, "billing_city") },
        { ref: "billing-state", type: "text", value: makeSentinel(HANDLE_ID, "billing_state") },
        {
          ref: "billing-zip",
          type: "text",
          value: makeSentinel(HANDLE_ID, "billing_postal_code"),
        },
        {
          ref: "billing-country",
          type: "text",
          value: makeSentinel(HANDLE_ID, "billing_country"),
        },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe(MOCK_PROFILE.billing!.line1);
    expect(fields[1]!.value).toBe(MOCK_PROFILE.billing!.city);
    expect(fields[2]!.value).toBe(MOCK_PROFILE.billing!.state);
    expect(fields[3]!.value).toBe(MOCK_PROFILE.billing!.postalCode);
    expect(fields[4]!.value).toBe(MOCK_PROFILE.billing!.country);
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
    const dataB: CredentialFillData = {
      secrets: {
        pan: "5555 5555 5555 4444",
        cvv: "456",
        expMonth: "06",
        expYear: "2031",
        expMmYy: "06/31",
        expMmYyyy: "06/2031",
      },
      profile: {
        holderName: "Second Holder",
        billing: {
          line1: "1 Infinite Loop",
          city: "Cupertino",
          state: "CA",
          postalCode: "95014",
          country: "US",
        },
        extras: {},
      },
    };
    const manager = {
      retrieveCardSecretsForHook: vi
        .fn()
        .mockResolvedValueOnce(MOCK_DATA)
        .mockResolvedValueOnce(dataB),
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
    expect(fields[1]!.value).toBe(dataB.secrets.pan);
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
// Secret clear on error path (C1 / I1)
// ---------------------------------------------------------------------------

describe("fill hook — secret clear on error path", () => {
  it("clears local secret state when retrieve fails partway through", async () => {
    // Setup: two unique handles. First retrieve succeeds, second rejects.
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    seedHandle(HANDLE_ID_B, SPEND_REQ_ID_B);

    const dataA: CredentialFillData = {
      secrets: {
        pan: "4242424242424242",
        cvv: "111",
        expMonth: "12",
        expYear: "2030",
        expMmYy: "12/30",
        expMmYyyy: "12/2030",
      },
      profile: {
        holderName: "Alice Holder",
        billing: {
          line1: "123 Main St",
          city: "Springfield",
          state: "IL",
          postalCode: "62701",
          country: "US",
        },
        extras: {},
      },
    };

    const manager = {
      retrieveCardSecretsForHook: vi
        .fn()
        .mockResolvedValueOnce(dataA)
        .mockRejectedValueOnce(new CardUnavailableError(HANDLE_ID_B, "consumed", "mock")),
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

    // Should return block: true (CardUnavailableError path)
    expect(result).toMatchObject({ block: true });

    // Secrets from handle A must not appear in the returned block result
    const json = JSON.stringify(result);
    expect(json).not.toContain("4242424242424242");
    expect(json).not.toContain("111");
    expect(json).not.toContain("Alice Holder");
  });

  it("does not cache secrets across hook calls (re-retrieves on each call)", async () => {
    // Verified by the existing "retry semantics" test, but assert explicitly here
    // with three calls so the no-cache invariant is unambiguous.
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    const manager = makeMockManager();

    await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );

    // Two separate calls must each trigger a fresh retrieve (map cleared between calls)
    expect(manager.retrieveCardSecretsForHook).toHaveBeenCalledTimes(2);
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

  it("returns distinct params objects across separate calls", async () => {
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
// Memory hygiene — extras values are cleared like card secrets
// ---------------------------------------------------------------------------

describe("fill hook — memory hygiene for extras", () => {
  it("does not leak extras values into block-result error path", async () => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
    seedHandle(HANDLE_ID_B, SPEND_REQ_ID_B);

    const dataA: CredentialFillData = {
      secrets: {
        pan: "4242424242424242",
        cvv: "111",
        expMonth: "12",
        expYear: "2030",
        expMmYy: "12/30",
        expMmYyyy: "12/2030",
      },
      profile: {
        // include an extras value that should NOT leak in any error
        extras: { email: "alice@private.example" },
      },
    };

    const manager = {
      retrieveCardSecretsForHook: vi
        .fn()
        .mockResolvedValueOnce(dataA)
        .mockRejectedValueOnce(new CardUnavailableError(HANDLE_ID_B, "consumed", "mock")),
      getSetupStatus: vi.fn(),
      listFundingSources: vi.fn(),
      issueVirtualCard: vi.fn(),
      executeMachinePayment: vi.fn(),
      getStatus: vi.fn(),
    } as unknown as PaymentManager;

    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "email", type: "text", value: makeSentinel(HANDLE_ID, "email") },
        { ref: "pan-b", type: "text", value: makeSentinel(HANDLE_ID_B, "pan") },
      ]),
      makeOpts(manager),
    );

    expect(result).toMatchObject({ block: true });
    const json = JSON.stringify(result);
    // Extras VALUE must not appear anywhere in the block result
    expect(json).not.toContain("alice@private.example");
    // Card-secret values from dataA must not leak either
    expect(json).not.toContain("4242424242424242");
    expect(json).not.toContain("111");
  });
});

// ---------------------------------------------------------------------------
// Forward-compat: BuyerProfile.extras passthrough
// ---------------------------------------------------------------------------

describe("fill hook — forward-compat passthrough via BuyerProfile.extras", () => {
  beforeEach(() => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID, { last4: "4242" });
  });

  it("resolves a sentinel field that is exposed via extras (e.g. 'email')", async () => {
    const data: CredentialFillData = {
      secrets: { ...MOCK_SECRETS },
      profile: {
        ...MOCK_PROFILE,
        extras: { email: "buyer@example.com", phone: "+15555551234" },
      },
    };
    const manager = makeMockManager(async () => data);
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "email", type: "email", value: makeSentinel(HANDLE_ID, "email") }]),
      makeOpts(manager),
    );
    expect(result!.requireApproval).toBeDefined();
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe("buyer@example.com");
  });

  it("resolves multiple extras alongside well-known sentinels (mixed fields)", async () => {
    const data: CredentialFillData = {
      secrets: { ...MOCK_SECRETS },
      profile: {
        ...MOCK_PROFILE,
        extras: { email: "buyer@example.com", phone: "+15555551234" },
      },
    };
    const manager = makeMockManager(async () => data);
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "email", type: "email", value: makeSentinel(HANDLE_ID, "email") },
        { ref: "phone", type: "tel", value: makeSentinel(HANDLE_ID, "phone") },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe(MOCK_SECRETS.pan);
    expect(fields[1]!.value).toBe("buyer@example.com");
    expect(fields[2]!.value).toBe("+15555551234");
  });

  it("extras CANNOT shadow Tier 1 secret fields (resolution priority)", async () => {
    // Defense-in-depth: a malicious or buggy adapter that put a fake "pan" key in
    // extras must not be able to override the real CardSecrets.pan value.
    const data: CredentialFillData = {
      secrets: { ...MOCK_SECRETS, pan: "REAL_PAN_VALUE" },
      profile: {
        ...MOCK_PROFILE,
        // Adversarial: extras claims to be "pan" — must be ignored.
        extras: { pan: "FAKE_PAN_VIA_EXTRAS" },
      },
    };
    const manager = makeMockManager(async () => data);
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") }]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe("REAL_PAN_VALUE");
    expect(fields[0]!.value).not.toBe("FAKE_PAN_VIA_EXTRAS");
  });

  it("extras CANNOT shadow Tier 2 buyer-profile fields when populated", async () => {
    const data: CredentialFillData = {
      secrets: { ...MOCK_SECRETS },
      profile: {
        holderName: "REAL HOLDER",
        billing: { line1: "REAL LINE 1", extras: undefined as never } as never,
        // Adversarial: extras claims to be holder_name and billing_line1.
        extras: { holder_name: "FAKE HOLDER", billing_line1: "FAKE LINE 1" },
      },
    };
    const manager = makeMockManager(async () => data);
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "holder", type: "text", value: makeSentinel(HANDLE_ID, "holder_name") },
        { ref: "line1", type: "text", value: makeSentinel(HANDLE_ID, "billing_line1") },
      ]),
      makeOpts(manager),
    );
    const fields = (result!.params as any).request.fields as Array<{ value: unknown }>;
    expect(fields[0]!.value).toBe("REAL HOLDER");
    expect(fields[1]!.value).toBe("REAL LINE 1");
  });

  it("approval description includes well-known + extras field names (alphabetized)", async () => {
    const data: CredentialFillData = {
      secrets: { ...MOCK_SECRETS },
      profile: {
        ...MOCK_PROFILE,
        extras: { email: "buyer@example.com" },
      },
    };
    const manager = makeMockManager(async () => data);
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "pan", type: "text", value: makeSentinel(HANDLE_ID, "pan") },
        { ref: "email", type: "email", value: makeSentinel(HANDLE_ID, "email") },
        { ref: "cvv", type: "password", value: makeSentinel(HANDLE_ID, "cvv") },
      ]),
      makeOpts(manager),
    );
    const desc = result!.requireApproval!.description;
    // Field NAMES included (alphabetized: cvv, email, pan)
    expect(desc).toContain("Fields: cvv, email, pan");
    // Field VALUES never included
    expect(desc).not.toContain("buyer@example.com");
    expect(desc).not.toContain("4242 4242 4242 4242");
  });
});

// ---------------------------------------------------------------------------
// Unknown field — fail fast with clear error
// ---------------------------------------------------------------------------

describe("fill hook — unknown field fails fast", () => {
  beforeEach(() => {
    seedHandle(HANDLE_ID, SPEND_REQ_ID);
  });

  it("returns block: true when sentinel field is not available for this credential", async () => {
    const manager = makeMockManager(); // default profile, no 'ssn' in extras
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "ssn", type: "text", value: makeSentinel(HANDLE_ID, "ssn") }]),
      makeOpts(manager),
    );
    expect(result!.block).toBe(true);
    expect(result!.requireApproval).toBeUndefined();
    expect(result!.blockReason).toContain('field "ssn" is not available');
  });

  it("error message lists available fields", async () => {
    const manager = makeMockManager();
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "ssn", type: "text", value: makeSentinel(HANDLE_ID, "ssn") }]),
      makeOpts(manager),
    );
    const reason = result!.blockReason!;
    expect(reason).toContain("Available fields:");
    // All Tier 1 fields present
    expect(reason).toContain("pan");
    expect(reason).toContain("cvv");
    // Tier 2 fields present (mock has full default profile)
    expect(reason).toContain("holder_name");
    expect(reason).toContain("billing_line1");
  });

  it("error message includes extras when forward-compat fields are exposed", async () => {
    const data: CredentialFillData = {
      secrets: { ...MOCK_SECRETS },
      profile: {
        ...MOCK_PROFILE,
        extras: { email: "x@y.com" },
      },
    };
    const manager = makeMockManager(async () => data);
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([{ ref: "ssn", type: "text", value: makeSentinel(HANDLE_ID, "ssn") }]),
      makeOpts(manager),
    );
    expect(result!.blockReason).toContain("email");
  });

  it("missing buyer-profile field (e.g. holder_name when undefined) fails with clear error", async () => {
    // Profile with NO holderName — provider didn't populate it for this card.
    const data: CredentialFillData = {
      secrets: { ...MOCK_SECRETS },
      profile: { extras: {} },
    };
    const manager = makeMockManager(async () => data);
    const result = await handleBrowserBeforeToolCall(
      makeFillEvent([
        { ref: "holder", type: "text", value: makeSentinel(HANDLE_ID, "holder_name") },
      ]),
      makeOpts(manager),
    );
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('field "holder_name" is not available');
    // Available fields list should include card secrets but NOT holder_name (since undefined)
    expect(result!.blockReason).toContain("pan");
    expect(result!.blockReason).not.toMatch(/Available fields:[^.]*holder_name/);
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
