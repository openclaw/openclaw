/**
 * stripe-link.test.ts — Adapter tests using fixture-replaying CommandRunner.
 *
 * ============================================================================
 * FIXTURE SHAPE ASSUMPTIONS (to be verified during U6 acceptance testing)
 * ============================================================================
 *
 * All fixture JSON files under fixtures/stripe-link/ represent ASSUMED shapes
 * for `link-cli` output. The actual Stripe Link CLI may differ. Discrepancies
 * will be caught during U6 acceptance testing against a real link-cli binary.
 *
 * Key assumptions:
 *
 * A. `link-cli auth status --format json` →
 *      { authenticated: boolean, account: object|null, version?: string }
 *
 * B. `link-cli payment-methods list --format json` →
 *      Array<{ id, funding_source_type ("card"|"stablecoin"), card?: { brand, last4, exp_month, exp_year },
 *               currency, available_balance_cents?, display_name? }>
 *
 * C. `link-cli spend-request create --format json ...` →
 *      { spend_request: { id, status ("approved"|"denied"|"pending"|"expired"),
 *                          valid_until?: string, card?: { brand, last4, exp_month, exp_year } } }
 *
 * D. `link-cli spend-request retrieve --format json --include=card <id>` →
 *      { spend_request: { id, status, card: { number, cvc, exp_month, exp_year,
 *                                             brand, last4, cardholder_name } } }
 *      Without --include=card, the `number` and `cvc` fields are absent.
 *
 * E. `link-cli spend-request create --credential-type=shared_payment_token ...` →
 *      { spend_request: { id, status, shared_payment_token: "spt_..." } }
 *
 * F. `link-cli mpp pay --format json --token-stdin ...` →
 *      { result: { outcome ("settled"|"failed"|"pending"), status_code, receipt_id, issued_at } }
 *
 * G. Non-zero exit code from `link-cli spend-request retrieve --include=card`
 *    indicates card unavailable/consumed. The adapter throws CardUnavailableError.
 *
 * ============================================================================
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaxAmountExceededError } from "../policy.js";
import { handleMap } from "../store.js";
import { CardUnavailableError, PolicyDeniedError, ProviderUnavailableError } from "./base.js";
// We import the fixture JSON files statically. Vitest supports JSON imports.
import authStatusAuthenticated from "./fixtures/stripe-link/auth-status-authenticated-test.json" assert { type: "json" };
import authStatusUnauthenticated from "./fixtures/stripe-link/auth-status-unauthenticated.json" assert { type: "json" };
import mppPayFailed from "./fixtures/stripe-link/mpp-pay-failed.json" assert { type: "json" };
// ---------------------------------------------------------------------------
// Fixture loader helpers
// ---------------------------------------------------------------------------
import mppPaySettled from "./fixtures/stripe-link/mpp-pay-settled.json" assert { type: "json" };
import paymentMethodsList from "./fixtures/stripe-link/payment-methods-list.json" assert { type: "json" };
import spendRequestCreateApprovedMpp from "./fixtures/stripe-link/spend-request-create-approved-mpp.json" assert { type: "json" };
import spendRequestCreateApproved from "./fixtures/stripe-link/spend-request-create-approved.json" assert { type: "json" };
import spendRequestCreateDenied from "./fixtures/stripe-link/spend-request-create-denied.json" assert { type: "json" };
import spendRequestCreateExpired from "./fixtures/stripe-link/spend-request-create-expired.json" assert { type: "json" };
import spendRequestCreatePending from "./fixtures/stripe-link/spend-request-create-pending.json" assert { type: "json" };
import spendRequestRetrieveCardConsumed from "./fixtures/stripe-link/spend-request-retrieve-card-consumed.json" assert { type: "json" };
import spendRequestRetrieveWithCard from "./fixtures/stripe-link/spend-request-retrieve-with-card.json" assert { type: "json" };
import spendRequestRetrieveWithoutCard from "./fixtures/stripe-link/spend-request-retrieve-without-card.json" assert { type: "json" };
import type { CommandRunner } from "./runner.js";
import { createStripeLinkAdapter } from "./stripe-link.js";
import type { StripeLinkAdapterOptions } from "./stripe-link.js";

// ---------------------------------------------------------------------------
// Fixture runner factory
// ---------------------------------------------------------------------------

/**
 * Creates a CommandRunner that replays a fixed response for any invocation.
 * The vi.fn() wrapper lets tests spy on the args that were passed.
 */
function makeFixtureRunner(response: { stdout: string; stderr?: string; exitCode: number }): {
  runner: CommandRunner;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_cmd: string, _args: readonly string[]) => ({
    stdout: response.stdout,
    stderr: response.stderr ?? "",
    exitCode: response.exitCode,
  }));
  return { runner: spy as unknown as CommandRunner, spy };
}

/**
 * Creates a CommandRunner that returns different responses for each call (in order).
 * Useful for two-step flows (create + pay).
 */
function makeSequentialFixtureRunner(
  responses: Array<{ stdout: string; stderr?: string; exitCode: number }>,
): { runner: CommandRunner; spy: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  const spy = vi.fn(async () => {
    const response = responses[callIndex % responses.length];
    callIndex++;
    return {
      stdout: response!.stdout,
      stderr: response!.stderr ?? "",
      exitCode: response!.exitCode,
    };
  });
  return { runner: spy as unknown as CommandRunner, spy };
}

function fixtureOk(data: unknown): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: JSON.stringify(data), stderr: "", exitCode: 0 };
}

function fixtureErr(data: unknown): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: JSON.stringify(data), stderr: "error", exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const VALID_PURCHASE_INTENT =
  "I am authorizing a software subscription purchase from Acme Corp for the monthly developer plan. " +
  "This charge is approved by the account holder for business use.";

const BASE_AMOUNT = { amountCents: 2500, currency: "usd" };
const BASE_MERCHANT = { name: "Test Merchant", url: "https://merchant.example.com" };

function makeAdapter(overrides: Partial<StripeLinkAdapterOptions> & { runner: CommandRunner }) {
  return createStripeLinkAdapter({
    command: "link-cli",
    clientName: "TestClient",
    testMode: false,
    maxAmountCents: 50000,
    ...overrides,
  });
}

function makeTestAdapter(overrides: Partial<StripeLinkAdapterOptions> & { runner: CommandRunner }) {
  return createStripeLinkAdapter({
    command: "link-cli",
    clientName: "TestClient",
    testMode: true,
    maxAmountCents: 50000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// beforeEach: clear handleMap
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const id of [...handleMap._map.keys()]) {
    handleMap.delete(id);
  }
});

// ---------------------------------------------------------------------------
// 1. getSetupStatus
// ---------------------------------------------------------------------------

describe("getSetupStatus", () => {
  it("returns available=true when authenticated", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    const status = await adapter.getSetupStatus();
    expect(status.available).toBe(true);
    expect(status.authState).toBe("authenticated");
    expect(status.testMode).toBe(false);
  });

  it("returns available=false when unauthenticated (exit 0 but authenticated=false)", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(authStatusUnauthenticated));
    const adapter = makeAdapter({ runner });
    const status = await adapter.getSetupStatus();
    expect(status.available).toBe(false);
    expect(status.authState).toBe("unauthenticated");
    expect(status.reason).toMatch(/not authenticated/i);
  });

  it("returns available=false when exit code is non-zero", async () => {
    const { runner } = makeFixtureRunner({ stdout: "", stderr: "not found", exitCode: 127 });
    const adapter = makeAdapter({ runner });
    const status = await adapter.getSetupStatus();
    expect(status.available).toBe(false);
    expect(status.authState).toBe("unauthenticated");
  });

  it("extracts providerVersion from JSON", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    const status = await adapter.getSetupStatus();
    expect(status.providerVersion).toBe("1.2.3");
  });

  it("includes --test flag when testMode=true", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeTestAdapter({ runner });
    await adapter.getSetupStatus();
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("--test");
  });

  it("does NOT include --include=card (security invariant)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    await adapter.getSetupStatus();
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--include=card");
  });

  it("passes correct base args: auth status --format json", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    await adapter.getSetupStatus();
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("auth");
    expect(args).toContain("status");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("returns available=false and authState=unknown when non-JSON output", async () => {
    const { runner } = makeFixtureRunner({ stdout: "not json", stderr: "", exitCode: 0 });
    const adapter = makeAdapter({ runner });
    const status = await adapter.getSetupStatus();
    expect(status.available).toBe(false);
    expect(status.authState).toBe("unknown");
  });

  it("throws ProviderUnavailableError when subprocess fails to spawn", async () => {
    const errorRunner: CommandRunner = async () => {
      throw new Error("spawn link-cli ENOENT");
    };
    const adapter = makeAdapter({ runner: errorRunner });
    await expect(adapter.getSetupStatus()).rejects.toThrow(ProviderUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// 2. listFundingSources
// ---------------------------------------------------------------------------

describe("listFundingSources", () => {
  it("returns two funding sources from fixture", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    const sources = await adapter.listFundingSources({});
    expect(sources).toHaveLength(2);
  });

  it("maps card payment method correctly", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    const sources = await adapter.listFundingSources({});
    const card = sources.find((s) => s.id === "pm_test_card_visa_4242");
    expect(card).toBeDefined();
    expect(card?.provider).toBe("stripe-link");
    expect(card?.rails).toContain("virtual_card");
    expect(card?.rails).toContain("machine_payment");
    expect(card?.settlementAssets).toContain("usd_card");
    expect(card?.displayName).toMatch(/Visa/);
    expect(card?.displayName).toMatch(/4242/);
    expect(card?.currency).toBe("usd");
    expect(card?.availableBalanceCents).toBe(500000);
  });

  it("maps stablecoin payment method to usdc settlement", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    const sources = await adapter.listFundingSources({});
    const usdc = sources.find((s) => s.id === "pm_test_usdc_001");
    expect(usdc).toBeDefined();
    expect(usdc?.settlementAssets).toContain("usdc");
    expect(usdc?.settlementAssets).not.toContain("usd_card");
  });

  it("does NOT include --include=card (security invariant)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    await adapter.listFundingSources({});
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--include=card");
  });

  it("passes correct base args: payment-methods list --format json", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    await adapter.listFundingSources({});
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("payment-methods");
    expect(args).toContain("list");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("throws ProviderUnavailableError when exit code is non-zero", async () => {
    const { runner } = makeFixtureRunner(fixtureErr({ error: "unauthorized" }));
    const adapter = makeAdapter({ runner });
    await expect(adapter.listFundingSources({})).rejects.toThrow(ProviderUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// 3. issueVirtualCard
// ---------------------------------------------------------------------------

describe("issueVirtualCard", () => {
  it("happy path: returns approved CredentialHandle", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    expect(handle.status).toBe("approved");
    expect(handle.provider).toBe("stripe-link");
    expect(handle.rail).toBe("virtual_card");
    expect(handle.id).toMatch(/^slh-/);
    expect(handle.providerRequestId).toBe("spreq_test_approved_001");
  });

  it("returns denied status for denied spend request", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateDenied));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    expect(handle.status).toBe("denied");
  });

  it("returns pending_approval status for pending spend request", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreatePending));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    expect(handle.status).toBe("pending_approval");
  });

  it("maps expired terminal status to status: 'expired'", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateExpired));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    expect(handle.status).toBe("expired");
    expect(handle.provider).toBe("stripe-link");
    expect(handle.providerRequestId).toBe("spreq_expired_001");
  });

  it("treats poll-timeout (status still pending after --request-approval times out) as pending_approval", async () => {
    // When link-cli's --request-approval times out internally it exits non-zero,
    // but if it exits 0 with a pending status (e.g. on a partial timeout), the
    // adapter maps it to pending_approval so the manager can re-poll via getStatus.
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreatePending));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-pending-timeout",
    });
    expect(handle.status).toBe("pending_approval");
    // Manager can call getStatus(handle.id) to re-poll
    const meta = handleMap.get(handle.id);
    expect(meta).toBeDefined();
    expect(meta?.providerId).toBe("stripe-link");
  });

  it("populates all 5 fillSentinels referencing the handle id", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    expect(handle.fillSentinels).toBeDefined();
    const s = handle.fillSentinels!;
    expect(s.pan).toEqual({ $paymentHandle: handle.id, field: "pan" });
    expect(s.cvv).toEqual({ $paymentHandle: handle.id, field: "cvv" });
    expect(s.exp_month).toEqual({ $paymentHandle: handle.id, field: "exp_month" });
    expect(s.exp_year).toEqual({ $paymentHandle: handle.id, field: "exp_year" });
    expect(s.holder_name).toEqual({ $paymentHandle: handle.id, field: "holder_name" });
  });

  it("populates handleMap with providerId='stripe-link' and spendRequestId", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    const meta = handleMap.get(handle.id);
    expect(meta).toBeDefined();
    expect(meta?.providerId).toBe("stripe-link");
    expect(meta?.spendRequestId).toBe("spreq_test_approved_001");
    expect(meta?.last4).toBe("4242");
  });

  it("does NOT include --include=card (security invariant)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--include=card");
  });

  it("passes correct CLI args for spend-request create", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: { amountCents: 1500, currency: "usd" },
      merchant: { name: "Acme Corp" },
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "my-key-123",
    });
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("spend-request");
    expect(args).toContain("create");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("--request-approval");
    expect(args).toContain("--client-name");
    expect(args).toContain("TestClient");
    expect(args).toContain("--payment-method");
    expect(args).toContain("pm_test_card_visa_4242");
    expect(args).toContain("--amount");
    expect(args).toContain("1500");
    expect(args).toContain("--currency");
    expect(args).toContain("usd");
    expect(args).toContain("--merchant-name");
    expect(args).toContain("Acme Corp");
    expect(args).toContain("--idempotency-key");
    expect(args).toContain("my-key-123");
  });

  it("rejects purchaseIntent < 100 chars BEFORE calling runner", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: "too short",
        idempotencyKey: "test-key-001",
      }),
    ).rejects.toThrow(PolicyDeniedError);
    // Runner must NOT have been called — pre-shell-out validation
    expect(spy).not.toHaveBeenCalled();
  });

  it("PolicyDeniedError has correct providerId and reason for short purchaseIntent", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    let caught: PolicyDeniedError | undefined;
    try {
      await adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: "short",
        idempotencyKey: "test-key-001",
      });
    } catch (err) {
      caught = err as PolicyDeniedError;
    }
    expect(caught).toBeInstanceOf(PolicyDeniedError);
    expect(caught?.providerId).toBe("stripe-link");
    expect(caught?.reason).toContain("purchaseIntent");
  });

  it("rejects amount > maxAmountCents with MaxAmountExceededError BEFORE calling runner", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = createStripeLinkAdapter({
      command: "link-cli",
      clientName: "TestClient",
      testMode: false,
      maxAmountCents: 1000,
      runner,
    });
    await expect(
      adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: { amountCents: 5000, currency: "usd" },
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
        idempotencyKey: "test-key-001",
      }),
    ).rejects.toThrow(MaxAmountExceededError);
    // Runner must NOT have been called
    expect(spy).not.toHaveBeenCalled();
  });

  it("MaxAmountExceededError has correct maxCents and requestedCents", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = createStripeLinkAdapter({
      command: "link-cli",
      clientName: "TestClient",
      testMode: false,
      maxAmountCents: 1000,
      runner,
    });
    let caught: MaxAmountExceededError | undefined;
    try {
      await adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: { amountCents: 5000, currency: "usd" },
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
        idempotencyKey: "test-key-001",
      });
    } catch (err) {
      caught = err as MaxAmountExceededError;
    }
    expect(caught).toBeInstanceOf(MaxAmountExceededError);
    expect(caught?.maxCents).toBe(1000);
    expect(caught?.requestedCents).toBe(5000);
  });

  it("rejects empty idempotencyKey with PolicyDeniedError BEFORE calling runner", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
        idempotencyKey: "   ", // whitespace only — effectively empty
      }),
    ).rejects.toThrow(PolicyDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows undefined idempotencyKey (key generated internally)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      // no idempotencyKey
    });
    expect(handle.status).toBe("approved");
    // Runner was called — key was generated internally
    expect(spy).toHaveBeenCalledTimes(1);
    const [_cmd, args] = spy.mock.calls[0]!;
    const keyIdx = (args as string[]).indexOf("--idempotency-key");
    expect(keyIdx).toBeGreaterThanOrEqual(0);
    const generatedKey = (args as string[])[keyIdx + 1];
    expect(generatedKey).toBeTruthy();
  });

  it("includes --test flag when testMode=true", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeTestAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("--test");
  });

  it("throws ProviderUnavailableError when exit code is non-zero", async () => {
    const { runner } = makeFixtureRunner(fixtureErr({ error: "server error" }));
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
        idempotencyKey: "test-key-001",
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("extracts display brand, last4, expMonth, expYear from card field", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    expect(handle.display?.brand).toBe("visa");
    expect(handle.display?.last4).toBe("4242");
    expect(handle.display?.expMonth).toBe("12");
    expect(handle.display?.expYear).toBe("2030");
  });
});

// ---------------------------------------------------------------------------
// 4. retrieveCardSecrets — THE ONLY place --include=card appears
// ---------------------------------------------------------------------------

describe("retrieveCardSecrets", () => {
  it("happy path: returns CardSecrets with pan, cvv, expMonth, expYear, holderName", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    const secrets = await adapter.retrieveCardSecrets("spreq_test_approved_001");
    // Stripe test PAN — Luhn-valid, documented test value
    expect(secrets.pan).toBe("4242424242424242");
    expect(secrets.cvv).toBe("123");
    expect(secrets.expMonth).toBe("12");
    expect(secrets.expYear).toBe("2030");
    expect(secrets.holderName).toBe("OPENCLAW VIRTUAL");
  });

  it("DOES include --include=card in the CLI args (security invariant: ONLY here)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("spreq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("--include=card");
  });

  it("passes the spendRequestId as an argument", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("spreq_test_specific_id");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("spreq_test_specific_id");
  });

  it("passes correct base args: spend-request retrieve --format json --include=card <id>", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("spreq_test_approved_001");
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("spend-request");
    expect(args).toContain("retrieve");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("--include=card");
    expect(args).toContain("spreq_test_approved_001");
  });

  it("throws CardUnavailableError when exit code is non-zero (card consumed)", async () => {
    const { runner } = makeFixtureRunner({ stdout: "{}", stderr: "error", exitCode: 1 });
    const adapter = makeAdapter({ runner });
    await expect(adapter.retrieveCardSecrets("spreq_consumed")).rejects.toThrow(
      CardUnavailableError,
    );
  });

  it("throws CardUnavailableError when retrieve indicates card consumed (fixture-driven)", async () => {
    // The card-consumed fixture has an error body with code "spend_request_consumed".
    // link-cli returns non-zero exit when the card is consumed; the adapter throws CardUnavailableError
    // without leaking any card data from the error body (defense-in-depth).
    const { runner } = makeFixtureRunner({
      stdout: JSON.stringify(spendRequestRetrieveCardConsumed),
      stderr: "spend_request_consumed",
      exitCode: 1,
    });
    const adapter = makeAdapter({ runner });
    let caught: CardUnavailableError | undefined;
    try {
      await adapter.retrieveCardSecrets("spreq_consumed");
    } catch (err) {
      caught = err as CardUnavailableError;
    }
    expect(caught).toBeInstanceOf(CardUnavailableError);
    // Generic message — no PAN/CVV in the error
    expect(caught?.message).toMatch(/card no longer available/i);
    expect(caught?.message).not.toMatch(/\d{13,19}/);
  });

  it("CardUnavailableError message does NOT contain card data (defense-in-depth)", async () => {
    const { runner } = makeFixtureRunner({ stdout: "{}", stderr: "error", exitCode: 1 });
    const adapter = makeAdapter({ runner });
    let caught: CardUnavailableError | undefined;
    try {
      await adapter.retrieveCardSecrets("spreq_consumed");
    } catch (err) {
      caught = err as CardUnavailableError;
    }
    expect(caught).toBeInstanceOf(CardUnavailableError);
    // The error message must not contain any card numbers or CVV values
    expect(caught?.message).not.toMatch(/\d{13,19}/);
    expect(caught?.message).not.toContain("4242");
    expect(caught?.message).not.toContain("123");
  });

  it("each call re-shells out (no caching — fresh fetch discipline)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("spreq_test_approved_001");
    await adapter.retrieveCardSecrets("spreq_test_approved_001");
    // Two calls must have been made — no caching
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws CardUnavailableError when card field missing (no --include=card on server)", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await expect(adapter.retrieveCardSecrets("spreq_test_approved_001")).rejects.toThrow(
      CardUnavailableError,
    );
  });

  it("includes --test flag when testMode=true", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeTestAdapter({ runner });
    await adapter.retrieveCardSecrets("spreq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("--test");
  });
});

// ---------------------------------------------------------------------------
// 5. executeMachinePayment
// ---------------------------------------------------------------------------

describe("executeMachinePayment", () => {
  it("happy path: returns settled MachinePaymentResult", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    const result = await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    expect(result.outcome).toBe("settled");
    expect(result.targetUrl).toBe("https://api.example.com/pay");
    expect(result.receipt?.receiptId).toBeTruthy();
    expect(result.receipt?.statusCode).toBe(200);
    expect(result.handleId).toMatch(/^slm-/);
  });

  it("returns failed outcome for mpp-pay-failed fixture", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPayFailed),
    ]);
    const adapter = makeAdapter({ runner });
    const result = await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "GET",
      idempotencyKey: "test-key-001",
    });
    expect(result.outcome).toBe("failed");
    expect(result.receipt?.statusCode).toBe(402);
  });

  it("does NOT include --include=card in step 1 (create) args (security invariant)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const [_cmd, step1Args] = spy.mock.calls[0]!;
    expect(step1Args).not.toContain("--include=card");
  });

  it("does NOT include --include=card in step 2 (mpp pay) args (security invariant)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const [_cmd2, step2Args] = spy.mock.calls[1]!;
    expect(step2Args).not.toContain("--include=card");
  });

  it("passes correct args for step 1 (spend-request create with credential-type)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const [cmd, step1Args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(step1Args).toContain("spend-request");
    expect(step1Args).toContain("create");
    expect(step1Args).toContain("--credential-type=shared_payment_token");
    expect(step1Args).toContain("--request-approval");
  });

  it("passes correct args for step 2 (mpp pay with --token-stdin)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const [cmd2, step2Args] = spy.mock.calls[1]!;
    expect(cmd2).toBe("link-cli");
    expect(step2Args).toContain("mpp");
    expect(step2Args).toContain("pay");
    expect(step2Args).toContain("--token-stdin");
    expect(step2Args).toContain("--target");
    expect(step2Args).toContain("https://api.example.com/pay");
    expect(step2Args).toContain("--method");
    expect(step2Args).toContain("POST");
  });

  it("MPP token is passed via stdin input, NOT as a visible CLI arg", async () => {
    // This verifies the security invariant: the token is delivered via stdin,
    // not via a CLI arg that would be visible in process listings.
    const callLog: Array<{ args: readonly string[]; input?: string }> = [];
    const capturingRunner: CommandRunner = async (_cmd, args, options) => {
      callLog.push({ args, input: options?.input });
      if (callLog.length === 1) {
        return fixtureOk(spendRequestCreateApprovedMpp);
      }
      return fixtureOk(mppPaySettled);
    };
    const adapter = makeAdapter({ runner: capturingRunner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });

    const step2 = callLog[1]!;
    // Token delivered via stdin, not as a CLI arg
    expect(step2.input).toBe("spt_test_abc123def456");
    // Token must NOT appear in the args array
    expect(step2.args).not.toContain("spt_test_abc123def456");
    // And must not appear at all as any arg
    const argsStr = step2.args.join(" ");
    expect(argsStr).not.toContain("spt_test_abc123def456");
  });

  it("MPP token does NOT appear in the returned MachinePaymentResult", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    const result = await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    // Serialize to JSON and check no token appears
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("spt_test_abc123def456");
    expect(serialized).not.toContain("shared_payment_token");
  });

  it("rejects empty idempotencyKey with PolicyDeniedError BEFORE calling runner", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.executeMachinePayment({
        fundingSourceId: "pm_test_card_visa_4242",
        targetUrl: "https://api.example.com/pay",
        method: "POST",
        idempotencyKey: "   ",
      }),
    ).rejects.toThrow(PolicyDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws ProviderUnavailableError when MPP spend-request is not approved", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreatePending));
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.executeMachinePayment({
        fundingSourceId: "pm_test_card_visa_4242",
        targetUrl: "https://api.example.com/pay",
        method: "POST",
        idempotencyKey: "test-key-001",
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("throws ProviderUnavailableError when step 1 fails (exit non-zero)", async () => {
    const { runner } = makeFixtureRunner(fixtureErr({ error: "server error" }));
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.executeMachinePayment({
        fundingSourceId: "pm_test_card_visa_4242",
        targetUrl: "https://api.example.com/pay",
        method: "POST",
        idempotencyKey: "test-key-001",
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("includes --test flag in both steps when testMode=true", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeTestAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const [_cmd1, step1Args] = spy.mock.calls[0]!;
    const [_cmd2, step2Args] = spy.mock.calls[1]!;
    expect(step1Args).toContain("--test");
    expect(step2Args).toContain("--test");
  });

  it("serializes body as JSON string and passes as --body arg", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      body: { amount: 2500 },
      idempotencyKey: "test-key-001",
    });
    const [_cmd2, step2Args] = spy.mock.calls[1]!;
    expect(step2Args).toContain("--body");
    const bodyIdx = (step2Args as string[]).indexOf("--body");
    expect((step2Args as string[])[bodyIdx + 1]).toBe('{"amount":2500}');
  });
});

// ---------------------------------------------------------------------------
// 6. getStatus
// ---------------------------------------------------------------------------

describe("getStatus", () => {
  it("returns updated CredentialHandle for a known handleId", async () => {
    // Seed handleMap
    handleMap.set("slh-spreq_test_approved_001", {
      spendRequestId: "spreq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.getStatus("slh-spreq_test_approved_001");
    expect(handle.id).toBe("slh-spreq_test_approved_001");
    expect(handle.status).toBe("approved");
    expect(handle.provider).toBe("stripe-link");
    expect(handle.providerRequestId).toBe("spreq_test_approved_001");
  });

  it("maps expired status to status: 'expired' in getStatus", async () => {
    handleMap.set("slh-spreq_expired_001", {
      spendRequestId: "spreq_expired_001",
      providerId: "stripe-link",
      last4: "0000",
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreateExpired));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.getStatus("slh-spreq_expired_001");
    expect(handle.status).toBe("expired");
    expect(handle.providerRequestId).toBe("spreq_expired_001");
  });

  it("maps pending status to pending_approval in getStatus (timeout/poll scenario)", async () => {
    handleMap.set("slh-spreq_test_pending_001", {
      spendRequestId: "spreq_test_pending_001",
      providerId: "stripe-link",
      last4: undefined,
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner(fixtureOk(spendRequestCreatePending));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.getStatus("slh-spreq_test_pending_001");
    // pending from link-cli maps to pending_approval so manager can re-poll
    expect(handle.status).toBe("pending_approval");
    expect(handle.providerRequestId).toBe("spreq_test_pending_001");
  });

  it("throws CardUnavailableError for unknown handleId", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await expect(adapter.getStatus("unknown-handle")).rejects.toThrow(CardUnavailableError);
  });

  it("does NOT include --include=card (security invariant)", async () => {
    handleMap.set("slh-spreq_test_approved_001", {
      spendRequestId: "spreq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await adapter.getStatus("slh-spreq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--include=card");
  });

  it("passes correct base args: spend-request retrieve --format json <spendRequestId>", async () => {
    handleMap.set("slh-spreq_test_approved_001", {
      spendRequestId: "spreq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await adapter.getStatus("slh-spreq_test_approved_001");
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("spend-request");
    expect(args).toContain("retrieve");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("spreq_test_approved_001");
  });

  it("throws CardUnavailableError when retrieve returns non-zero", async () => {
    handleMap.set("slh-spreq_test_approved_001", {
      spendRequestId: "spreq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner({ stdout: "", stderr: "not found", exitCode: 1 });
    const adapter = makeAdapter({ runner });
    await expect(adapter.getStatus("slh-spreq_test_approved_001")).rejects.toThrow(
      CardUnavailableError,
    );
  });

  it("CardUnavailableError for unknown handle carries the handleId", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    let caught: CardUnavailableError | undefined;
    try {
      await adapter.getStatus("unknown-handle-xyz");
    } catch (err) {
      caught = err as CardUnavailableError;
    }
    expect(caught).toBeInstanceOf(CardUnavailableError);
    expect(caught?.handleId).toBe("unknown-handle-xyz");
    expect(caught?.providerId).toBe("stripe-link");
  });

  it("includes --test flag when testMode=true", async () => {
    handleMap.set("slh-spreq_test_approved_001", {
      spendRequestId: "spreq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeTestAdapter({ runner });
    await adapter.getStatus("slh-spreq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("--test");
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-cutting: --include=card appears in EXACTLY retrieveCardSecrets
// ---------------------------------------------------------------------------

describe("security invariant: --include=card only in retrieveCardSecrets", () => {
  it("getSetupStatus never passes --include=card", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    await adapter.getSetupStatus();
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
    }
  });

  it("listFundingSources never passes --include=card", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    await adapter.listFundingSources({});
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
    }
  });

  it("issueVirtualCard never passes --include=card", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestCreateApproved));
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      idempotencyKey: "test-key-001",
    });
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
    }
  });

  it("executeMachinePayment never passes --include=card (all steps)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
    }
  });

  it("getStatus never passes --include=card", async () => {
    handleMap.set("slh-spreq_test_approved_001", {
      spendRequestId: "spreq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await adapter.getStatus("slh-spreq_test_approved_001");
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
    }
  });

  it("retrieveCardSecrets DOES pass --include=card", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("spreq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("--include=card");
  });
});

// ---------------------------------------------------------------------------
// 8. Adapter id and rails
// ---------------------------------------------------------------------------

describe("adapter metadata", () => {
  it("id is 'stripe-link'", () => {
    const { runner } = makeFixtureRunner(fixtureOk({}));
    const adapter = makeAdapter({ runner });
    expect(adapter.id).toBe("stripe-link");
  });

  it("rails contains virtual_card and machine_payment", () => {
    const { runner } = makeFixtureRunner(fixtureOk({}));
    const adapter = makeAdapter({ runner });
    expect(adapter.rails).toContain("virtual_card");
    expect(adapter.rails).toContain("machine_payment");
  });

  it("accepts pollIntervalMs and pollMaxAttempts options (reserved for future use)", () => {
    const adapter = createStripeLinkAdapter({
      clientName: "test",
      testMode: true,
      maxAmountCents: 50000,
      pollIntervalMs: 500,
      pollMaxAttempts: 60,
      runner: vi.fn(),
    });
    expect(adapter.id).toBe("stripe-link");
  });
});
