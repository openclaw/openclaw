/**
 * stripe-link.test.ts — Adapter tests using fixture-replaying CommandRunner.
 *
 * ============================================================================
 * FIXTURE SHAPES (verified against link-cli 0.4.0 live capture 2026-05-01)
 * ============================================================================
 *
 * A. `link-cli auth status --format json` →
 *      Array<{ authenticated: boolean, access_token, token_type, credentials_path,
 *               update: { current_version, latest_version, update_command } }>
 *    NOTE: --test flag is NOT valid here.
 *
 * B. `link-cli payment-methods list --format json` →
 *      Array<{ id, type: "CARD", name, is_default,
 *               card_details: { brand, last4, exp_month: number, exp_year: number } }>
 *    NOTE: --test flag is NOT valid here. No stablecoin discriminator in 0.4.0.
 *
 * C. `link-cli spend-request create ... --format json` →
 *      Array<{ id: "lsrq_...", status: "pending_approval", approval_url, _next, ... }>
 *    Does NOT block. Returns pending_approval immediately.
 *
 * D. `link-cli spend-request retrieve <id> --interval 2 --max-attempts 150 --format json` →
 *      Array of state-transition snapshots. Last element is terminal state.
 *
 * E. `link-cli spend-request retrieve <id> --include card --format json` →
 *      Array<{ id, status: "approved", card: { id, number, cvc, brand,
 *              exp_month: number, exp_year: number,
 *              billing_address: { name, ... }, valid_until }, ... }>
 *    NOTE: --include card is TWO separate args, not --include=card.
 *
 * Security invariants:
 *    - `--include` + `"card"` (as consecutive args) appears ONLY in retrieveCardSecrets.
 *    - MPP token never escapes executeMachinePayment.
 *    - No PAN/CVV in error messages.
 *    - No caching of card secrets.
 * ============================================================================
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaxAmountExceededError } from "../policy.js";
import { handleMap } from "../store.js";
import { CardUnavailableError, PolicyDeniedError, ProviderUnavailableError } from "./base.js";
import authStatusAuthenticated from "./fixtures/stripe-link/auth-status-authenticated-test.json" assert { type: "json" };
import authStatusUnauthenticated from "./fixtures/stripe-link/auth-status-unauthenticated.json" assert { type: "json" };
import mppPayFailed from "./fixtures/stripe-link/mpp-pay-failed.json" assert { type: "json" };
import mppPaySettled from "./fixtures/stripe-link/mpp-pay-settled.json" assert { type: "json" };
import paymentMethodsList from "./fixtures/stripe-link/payment-methods-list.json" assert { type: "json" };
import spendRequestCreateApprovedMpp from "./fixtures/stripe-link/spend-request-create-approved-mpp.json" assert { type: "json" };
import spendRequestCreateApproved from "./fixtures/stripe-link/spend-request-create-approved.json" assert { type: "json" };
import spendRequestCreateDenied from "./fixtures/stripe-link/spend-request-create-denied.json" assert { type: "json" };
import spendRequestCreateExpired from "./fixtures/stripe-link/spend-request-create-expired.json" assert { type: "json" };
import spendRequestCreatePending from "./fixtures/stripe-link/spend-request-create-pending.json" assert { type: "json" };
import spendRequestRetrieveCardConsumed from "./fixtures/stripe-link/spend-request-retrieve-card-consumed.json" assert { type: "json" };
import spendRequestRetrievePollApproved from "./fixtures/stripe-link/spend-request-retrieve-poll-approved.json" assert { type: "json" };
import spendRequestRetrievePollDenied from "./fixtures/stripe-link/spend-request-retrieve-poll-denied.json" assert { type: "json" };
import spendRequestRetrievePollExpired from "./fixtures/stripe-link/spend-request-retrieve-poll-expired.json" assert { type: "json" };
import spendRequestRetrievePollMppApproved from "./fixtures/stripe-link/spend-request-retrieve-poll-mpp-approved.json" assert { type: "json" };
import spendRequestRetrievePollPendingOnly from "./fixtures/stripe-link/spend-request-retrieve-poll-pending-only.json" assert { type: "json" };
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
 * Useful for multi-step flows (create + poll + retrieve-with-card).
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

  it("extracts providerVersion from update.current_version (link-cli 0.4.0 shape)", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    const status = await adapter.getSetupStatus();
    // link-cli 0.4.0 fixture has update.current_version = "0.4.0"
    expect(status.providerVersion).toBe("0.4.0");
  });

  it("does NOT include --test flag (auth status does not support --test in 0.4.0)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeTestAdapter({ runner });
    await adapter.getSetupStatus();
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--test");
  });

  it("does NOT include --include=card or --include card (security invariant)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    await adapter.getSetupStatus();
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--include=card");
    expect(args).not.toContain("--include");
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

  it("maps card payment method correctly (link-cli 0.4.0 shape)", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    const sources = await adapter.listFundingSources({});
    const card = sources.find((s) => s.id === "pm_test_card_visa_4242");
    expect(card).toBeDefined();
    expect(card?.provider).toBe("stripe-link");
    expect(card?.rails).toContain("virtual_card");
    expect(card?.rails).toContain("machine_payment");
    expect(card?.settlementAssets).toContain("usd_card");
    // displayName uses name field directly: "Atmos Rewards Visa Infinite"
    expect(card?.displayName).toBe("Atmos Rewards Visa Infinite");
    // currency defaults to usd (not in 0.4.0 response)
    expect(card?.currency).toBe("usd");
  });

  it("second card has correct displayName from name field", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    const sources = await adapter.listFundingSources({});
    const mc = sources.find((s) => s.id === "pm_test_card_mc_9999");
    expect(mc).toBeDefined();
    expect(mc?.displayName).toBe("Chase Sapphire Reserve");
    expect(mc?.settlementAssets).toContain("usd_card");
  });

  it("all items map to usd_card settlement (no stablecoin discriminator in 0.4.0)", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    const sources = await adapter.listFundingSources({});
    for (const src of sources) {
      expect(src.settlementAssets).toContain("usd_card");
    }
  });

  it("does NOT include --test flag (payment-methods list does not support --test in 0.4.0)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeTestAdapter({ runner });
    await adapter.listFundingSources({});
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--test");
  });

  it("does NOT include --include=card or --include card (security invariant)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    await adapter.listFundingSources({});
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--include=card");
    expect(args).not.toContain("--include");
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
//
// link-cli 0.4.0 flow: create (→ pending_approval) + poll (→ terminal) [+ card-retrieve if approved]
// Tests use sequential fixture runners for 2-call (create + poll) or 3-call flows.
// ---------------------------------------------------------------------------

describe("issueVirtualCard", () => {
  it("happy path: returns approved CredentialHandle after create+poll", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved), // create → pending_approval
      fixtureOk(spendRequestRetrievePollApproved), // poll → approved
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(handle.status).toBe("approved");
    expect(handle.provider).toBe("stripe-link");
    expect(handle.rail).toBe("virtual_card");
    expect(handle.id).toMatch(/^slh-/);
    // spendRequestId from create fixture: lsrq_test_approved_001
    expect(handle.providerRequestId).toBe("lsrq_test_approved_001");
  });

  it("returns denied status after create+poll with denied terminal", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateDenied), // create → pending_approval
      fixtureOk(spendRequestRetrievePollDenied), // poll → denied
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(handle.status).toBe("denied");
  });

  it("returns pending_approval when poll returns only pending_approval (max-attempts case)", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreatePending), // create → pending_approval
      fixtureOk(spendRequestRetrievePollPendingOnly), // poll → still pending
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(handle.status).toBe("pending_approval");
  });

  it("maps expired terminal status to status: 'expired'", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateExpired), // create → pending_approval
      fixtureOk(spendRequestRetrievePollExpired), // poll → expired
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(handle.status).toBe("expired");
    expect(handle.provider).toBe("stripe-link");
    expect(handle.providerRequestId).toBe("lsrq_expired_001");
  });

  it("treats poll-timeout (non-zero exit, pending status) as pending_approval", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreatePending),
      { stdout: JSON.stringify(spendRequestRetrievePollPendingOnly), stderr: "", exitCode: 1 }, // non-zero
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    expect(handle.status).toBe("pending_approval");
    const meta = handleMap.get(handle.id);
    expect(meta).toBeDefined();
    expect(meta?.providerId).toBe("stripe-link");
  });

  it("populates all 5 fillSentinels referencing the handle id", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
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
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    const meta = handleMap.get(handle.id);
    expect(meta).toBeDefined();
    expect(meta?.providerId).toBe("stripe-link");
    expect(meta?.spendRequestId).toBe("lsrq_test_approved_001");
  });

  it("does NOT include --include=card or --include card in create args (security invariant)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    // Check both create (call 0) and poll (call 1)
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
      // "--include" should NOT appear in any call from issueVirtualCard
      expect(args).not.toContain("--include");
    }
  });

  it("passes correct CLI args for spend-request create (0.4.0 shape)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: { amountCents: 1500, currency: "usd" },
      merchant: { name: "Acme Corp", url: "https://acme.example.com" },
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("spend-request");
    expect(args).toContain("create");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("--request-approval");
    // 0.4.0: --payment-method-id (not --payment-method)
    expect(args).toContain("--payment-method-id");
    expect(args).toContain("pm_test_card_visa_4242");
    expect(args).toContain("--amount");
    expect(args).toContain("1500");
    expect(args).toContain("--currency");
    expect(args).toContain("usd");
    expect(args).toContain("--merchant-name");
    expect(args).toContain("Acme Corp");
    expect(args).toContain("--merchant-url");
    expect(args).toContain("https://acme.example.com");
    expect(args).toContain("--context");
    // 0.4.0: no --client-name, no --idempotency-key
    expect(args).not.toContain("--client-name");
    expect(args).not.toContain("--idempotency-key");
  });

  it("passes correct CLI args for spend-request retrieve poll", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    // Second call is the poll
    const [cmd, args] = spy.mock.calls[1]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("spend-request");
    expect(args).toContain("retrieve");
    expect(args).toContain("lsrq_test_approved_001");
    expect(args).toContain("--interval");
    expect(args).toContain("--max-attempts");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    // No --include here
    expect(args).not.toContain("--include");
  });

  it("rejects purchaseIntent < 100 chars BEFORE calling runner", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: "too short",
      }),
    ).rejects.toThrow(PolicyDeniedError);
    // Runner must NOT have been called — pre-shell-out validation
    expect(spy).not.toHaveBeenCalled();
  });

  it("PolicyDeniedError has correct providerId and reason for short purchaseIntent", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    let caught: PolicyDeniedError | undefined;
    try {
      await adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: "short",
      });
    } catch (err) {
      caught = err as PolicyDeniedError;
    }
    expect(caught).toBeInstanceOf(PolicyDeniedError);
    expect(caught?.providerId).toBe("stripe-link");
    expect(caught?.reason).toContain("purchaseIntent");
  });

  it("rejects amount > maxAmountCents with MaxAmountExceededError BEFORE calling runner", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
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
      }),
    ).rejects.toThrow(MaxAmountExceededError);
    // Runner must NOT have been called
    expect(spy).not.toHaveBeenCalled();
  });

  it("MaxAmountExceededError has correct maxCents and requestedCents", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
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
      });
    } catch (err) {
      caught = err as MaxAmountExceededError;
    }
    expect(caught).toBeInstanceOf(MaxAmountExceededError);
    expect(caught?.maxCents).toBe(1000);
    expect(caught?.requestedCents).toBe(5000);
  });

  it("rejects empty idempotencyKey with PolicyDeniedError BEFORE calling runner", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
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

  it("allows undefined idempotencyKey (no idempotency-key arg in 0.4.0)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    const handle = await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
      // no idempotencyKey
    });
    expect(handle.status).toBe("approved");
    // Runner was called (create + poll = 2 calls)
    expect(spy).toHaveBeenCalledTimes(2);
    // --idempotency-key should NOT appear in 0.4.0 args
    const [_cmd, createArgs] = spy.mock.calls[0]!;
    expect(createArgs).not.toContain("--idempotency-key");
  });

  it("includes --test on create only (NOT on retrieve poll) when testMode=true", async () => {
    // link-cli 0.4.0 supports --test on `spend-request create` only;
    // `spend-request retrieve` rejects it as Unknown flag.
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeTestAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    const [_cmd1, createArgs] = spy.mock.calls[0]!;
    const [_cmd2, pollArgs] = spy.mock.calls[1]!;
    expect(createArgs).toContain("--test");
    expect(pollArgs).not.toContain("--test");
  });

  it("throws ProviderUnavailableError when create exit code is non-zero", async () => {
    const { runner } = makeFixtureRunner(fixtureErr({ error: "server error" }));
    const adapter = makeAdapter({ runner });
    await expect(
      adapter.issueVirtualCard({
        fundingSourceId: "pm_test_card_visa_4242",
        amount: BASE_AMOUNT,
        merchant: BASE_MERCHANT,
        purchaseIntent: VALID_PURCHASE_INTENT,
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("uses --merchant-url fallback https://example.invalid when no url provided", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: { name: "No URL Merchant" }, // no url
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    const [_cmd, createArgs] = spy.mock.calls[0]!;
    expect(createArgs).toContain("--merchant-url");
    const urlIdx = (createArgs as string[]).indexOf("--merchant-url");
    expect((createArgs as string[])[urlIdx + 1]).toBe("https://example.invalid");
  });
});

// ---------------------------------------------------------------------------
// 4. retrieveCardSecrets — THE ONLY place --include card appears
// ---------------------------------------------------------------------------

describe("retrieveCardSecrets", () => {
  it("happy path: returns CardSecrets with pan, cvv, expMonth, expYear, holderName", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    const secrets = await adapter.retrieveCardSecrets("lsrq_test_approved_001");
    // Stripe test PAN — Luhn-valid, documented test value
    expect(secrets.pan).toBe("4242424242424242");
    expect(secrets.cvv).toBe("123");
    expect(secrets.expMonth).toBe("12");
    expect(secrets.expYear).toBe("2030");
    // holderName from card.billing_address.name in 0.4.0
    expect(secrets.holderName).toBe("Jane Doe");
  });

  it("DOES include --include card as TWO separate args (security invariant: ONLY here)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("lsrq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    // link-cli 0.4.0: --include card as two separate args
    const argsArr = args as string[];
    const includeIdx = argsArr.indexOf("--include");
    expect(includeIdx).toBeGreaterThanOrEqual(0);
    expect(argsArr[includeIdx + 1]).toBe("card");
    // NOT the old --include=card form
    expect(args).not.toContain("--include=card");
  });

  it("passes the spendRequestId as an argument", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("lsrq_test_specific_id");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("lsrq_test_specific_id");
  });

  it("passes correct base args: spend-request retrieve <id> --include card --format json", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("lsrq_test_approved_001");
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("spend-request");
    expect(args).toContain("retrieve");
    expect(args).toContain("lsrq_test_approved_001");
    expect(args).toContain("--include");
    expect(args).toContain("card");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("throws CardUnavailableError when exit code is non-zero (card consumed)", async () => {
    const { runner } = makeFixtureRunner({ stdout: "{}", stderr: "error", exitCode: 1 });
    const adapter = makeAdapter({ runner });
    await expect(adapter.retrieveCardSecrets("lsrq_consumed")).rejects.toThrow(
      CardUnavailableError,
    );
  });

  it("throws CardUnavailableError when retrieve indicates card consumed (fixture-driven)", async () => {
    const { runner } = makeFixtureRunner({
      stdout: JSON.stringify(spendRequestRetrieveCardConsumed),
      stderr: "spend_request_consumed",
      exitCode: 1,
    });
    const adapter = makeAdapter({ runner });
    let caught: CardUnavailableError | undefined;
    try {
      await adapter.retrieveCardSecrets("lsrq_consumed");
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
      await adapter.retrieveCardSecrets("lsrq_consumed");
    } catch (err) {
      caught = err as CardUnavailableError;
    }
    expect(caught).toBeInstanceOf(CardUnavailableError);
    expect(caught?.message).not.toMatch(/\d{13,19}/);
    expect(caught?.message).not.toContain("4242");
    expect(caught?.message).not.toContain("123");
  });

  it("each call re-shells out (no caching — fresh fetch discipline)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("lsrq_test_approved_001");
    await adapter.retrieveCardSecrets("lsrq_test_approved_001");
    // Two calls must have been made — no caching
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws CardUnavailableError when card field missing (no --include card on server)", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await expect(adapter.retrieveCardSecrets("lsrq_test_approved_001")).rejects.toThrow(
      CardUnavailableError,
    );
  });

  it("does NOT include --test on retrieve --include card (Unknown flag in link-cli 0.4.0)", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeTestAdapter({ runner });
    await adapter.retrieveCardSecrets("lsrq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--test");
  });
});

// ---------------------------------------------------------------------------
// 5. executeMachinePayment
// ---------------------------------------------------------------------------

describe("executeMachinePayment", () => {
  it("happy path: returns settled MachinePaymentResult (create + poll + mpp pay)", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp), // create → pending_approval
      fixtureOk(spendRequestRetrievePollMppApproved), // poll → approved with shared_payment_token
      fixtureOk(mppPaySettled), // mpp pay → settled
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
      fixtureOk(spendRequestRetrievePollMppApproved),
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

  it("does NOT include --include=card or --include card in any step (security invariant)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
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
      expect(args).not.toContain("--include");
    }
  });

  it("passes correct args for step 1 (spend-request create with credential-type)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
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
    expect(step1Args).toContain("--payment-method-id");
  });

  it("passes correct args for step 2 (spend-request retrieve poll for MPP)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const [cmd, step2Args] = spy.mock.calls[1]!;
    expect(cmd).toBe("link-cli");
    expect(step2Args).toContain("spend-request");
    expect(step2Args).toContain("retrieve");
    expect(step2Args).toContain("lsrq_test_mpp_approved_001");
    expect(step2Args).toContain("--interval");
    expect(step2Args).toContain("--max-attempts");
  });

  it("passes correct args for step 3 (mpp pay with --token-stdin)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const [cmd3, step3Args] = spy.mock.calls[2]!;
    expect(cmd3).toBe("link-cli");
    expect(step3Args).toContain("mpp");
    expect(step3Args).toContain("pay");
    expect(step3Args).toContain("--token-stdin");
    expect(step3Args).toContain("--target");
    expect(step3Args).toContain("https://api.example.com/pay");
    expect(step3Args).toContain("--method");
    expect(step3Args).toContain("POST");
  });

  it("MPP token is passed via stdin input, NOT as a visible CLI arg", async () => {
    const callLog: Array<{ args: readonly string[]; input?: string }> = [];
    const capturingRunner: CommandRunner = async (_cmd, args, options) => {
      callLog.push({ args, input: options?.input });
      if (callLog.length === 1) {
        return fixtureOk(spendRequestCreateApprovedMpp);
      }
      if (callLog.length === 2) {
        return fixtureOk(spendRequestRetrievePollMppApproved);
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

    const step3 = callLog[2]!;
    // Token delivered via stdin, not as a CLI arg
    expect(step3.input).toBe("spt_test_abc123def456");
    // Token must NOT appear in the args array
    expect(step3.args).not.toContain("spt_test_abc123def456");
    const argsStr = step3.args.join(" ");
    expect(argsStr).not.toContain("spt_test_abc123def456");
  });

  it("MPP token does NOT appear in the returned MachinePaymentResult", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
      fixtureOk(mppPaySettled),
    ]);
    const adapter = makeAdapter({ runner });
    const result = await adapter.executeMachinePayment({
      fundingSourceId: "pm_test_card_visa_4242",
      targetUrl: "https://api.example.com/pay",
      method: "POST",
      idempotencyKey: "test-key-001",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("spt_test_abc123def456");
    expect(serialized).not.toContain("shared_payment_token");
  });

  it("rejects empty idempotencyKey with PolicyDeniedError BEFORE calling runner", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
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

  it("throws ProviderUnavailableError when MPP poll does not return approved", async () => {
    const { runner } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollPendingOnly), // poll stays pending
    ]);
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

  it("includes --test on create + mpp pay but NOT on retrieve poll when testMode=true", async () => {
    // link-cli 0.4.0: --test valid on spend-request create and (assumed) mpp pay,
    // NOT valid on spend-request retrieve.
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
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
    const [_cmd3, step3Args] = spy.mock.calls[2]!;
    expect(step1Args).toContain("--test");
    expect(step2Args).not.toContain("--test");
    expect(step3Args).toContain("--test");
  });

  it("serializes body as JSON string and passes as --body arg", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
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
    const [_cmd3, step3Args] = spy.mock.calls[2]!;
    expect(step3Args).toContain("--body");
    const bodyIdx = (step3Args as string[]).indexOf("--body");
    expect((step3Args as string[])[bodyIdx + 1]).toBe('{"amount":2500}');
  });
});

// ---------------------------------------------------------------------------
// 6. getStatus
// ---------------------------------------------------------------------------

describe("getStatus", () => {
  it("returns updated CredentialHandle for a known handleId", async () => {
    // Seed handleMap with lsrq_ id
    handleMap.set("slh-lsrq_test_approved_001", {
      spendRequestId: "lsrq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.getStatus("slh-lsrq_test_approved_001");
    expect(handle.id).toBe("slh-lsrq_test_approved_001");
    expect(handle.status).toBe("approved");
    expect(handle.provider).toBe("stripe-link");
    expect(handle.providerRequestId).toBe("lsrq_test_approved_001");
  });

  it("maps expired status to status: 'expired' in getStatus", async () => {
    handleMap.set("slh-lsrq_expired_001", {
      spendRequestId: "lsrq_expired_001",
      providerId: "stripe-link",
      last4: "0000",
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrievePollExpired));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.getStatus("slh-lsrq_expired_001");
    expect(handle.status).toBe("expired");
    expect(handle.providerRequestId).toBe("lsrq_expired_001");
  });

  it("maps pending status to pending_approval in getStatus (timeout/poll scenario)", async () => {
    handleMap.set("slh-lsrq_test_pending_001", {
      spendRequestId: "lsrq_test_pending_001",
      providerId: "stripe-link",
      last4: undefined,
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrievePollPendingOnly));
    const adapter = makeAdapter({ runner });
    const handle = await adapter.getStatus("slh-lsrq_test_pending_001");
    expect(handle.status).toBe("pending_approval");
    expect(handle.providerRequestId).toBe("lsrq_test_pending_001");
  });

  it("throws CardUnavailableError for unknown handleId", async () => {
    const { runner } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await expect(adapter.getStatus("unknown-handle")).rejects.toThrow(CardUnavailableError);
  });

  it("does NOT include --include=card or --include card (security invariant)", async () => {
    handleMap.set("slh-lsrq_test_approved_001", {
      spendRequestId: "lsrq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await adapter.getStatus("slh-lsrq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--include=card");
    expect(args).not.toContain("--include");
  });

  it("passes correct base args: spend-request retrieve --format json <spendRequestId>", async () => {
    handleMap.set("slh-lsrq_test_approved_001", {
      spendRequestId: "lsrq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await adapter.getStatus("slh-lsrq_test_approved_001");
    const [cmd, args] = spy.mock.calls[0]!;
    expect(cmd).toBe("link-cli");
    expect(args).toContain("spend-request");
    expect(args).toContain("retrieve");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("lsrq_test_approved_001");
  });

  it("throws CardUnavailableError when retrieve returns non-zero", async () => {
    handleMap.set("slh-lsrq_test_approved_001", {
      spendRequestId: "lsrq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner } = makeFixtureRunner({ stdout: "", stderr: "not found", exitCode: 1 });
    const adapter = makeAdapter({ runner });
    await expect(adapter.getStatus("slh-lsrq_test_approved_001")).rejects.toThrow(
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

  it("does NOT include --test on getStatus retrieve (Unknown flag in link-cli 0.4.0)", async () => {
    handleMap.set("slh-lsrq_test_approved_001", {
      spendRequestId: "lsrq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });

    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeTestAdapter({ runner });
    await adapter.getStatus("slh-lsrq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).not.toContain("--test");
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-cutting: --include card appears ONLY in retrieveCardSecrets
// ---------------------------------------------------------------------------

describe("security invariant: --include card only in retrieveCardSecrets", () => {
  it("getSetupStatus never passes --include or --include=card", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(authStatusAuthenticated));
    const adapter = makeAdapter({ runner });
    await adapter.getSetupStatus();
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
      expect(args).not.toContain("--include");
    }
  });

  it("listFundingSources never passes --include or --include=card", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(paymentMethodsList));
    const adapter = makeAdapter({ runner });
    await adapter.listFundingSources({});
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
      expect(args).not.toContain("--include");
    }
  });

  it("issueVirtualCard never passes --include or --include=card (all CLI calls)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApproved),
      fixtureOk(spendRequestRetrievePollApproved),
    ]);
    const adapter = makeAdapter({ runner });
    await adapter.issueVirtualCard({
      fundingSourceId: "pm_test_card_visa_4242",
      amount: BASE_AMOUNT,
      merchant: BASE_MERCHANT,
      purchaseIntent: VALID_PURCHASE_INTENT,
    });
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
      expect(args).not.toContain("--include");
    }
  });

  it("executeMachinePayment never passes --include or --include=card (all steps)", async () => {
    const { runner, spy } = makeSequentialFixtureRunner([
      fixtureOk(spendRequestCreateApprovedMpp),
      fixtureOk(spendRequestRetrievePollMppApproved),
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
      expect(args).not.toContain("--include");
    }
  });

  it("getStatus never passes --include or --include=card", async () => {
    handleMap.set("slh-lsrq_test_approved_001", {
      spendRequestId: "lsrq_test_approved_001",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: new Date().toISOString(),
    });
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithoutCard));
    const adapter = makeAdapter({ runner });
    await adapter.getStatus("slh-lsrq_test_approved_001");
    for (const call of spy.mock.calls) {
      const args = call[1] as string[];
      expect(args).not.toContain("--include=card");
      expect(args).not.toContain("--include");
    }
  });

  it("retrieveCardSecrets DOES pass --include and card as separate args", async () => {
    const { runner, spy } = makeFixtureRunner(fixtureOk(spendRequestRetrieveWithCard));
    const adapter = makeAdapter({ runner });
    await adapter.retrieveCardSecrets("lsrq_test_approved_001");
    const [_cmd, args] = spy.mock.calls[0]!;
    expect(args).toContain("--include");
    expect(args).toContain("card");
    // Verify they're consecutive
    const argsArr = args as string[];
    const idx = argsArr.indexOf("--include");
    expect(argsArr[idx + 1]).toBe("card");
  });
});

// ---------------------------------------------------------------------------
// 7b. Quality fixes: cause propagation and stderr in errors
// ---------------------------------------------------------------------------

describe("quality fixes: cause propagation and stderr in errors", () => {
  it("propagates underlying error as cause when runner subprocess fails", async () => {
    const underlying = new Error("ENOENT: link-cli not on PATH");
    const runner = vi.fn().mockRejectedValue(underlying);
    const adapter = createStripeLinkAdapter({
      clientName: "test",
      testMode: true,
      maxAmountCents: 50000,
      runner,
    });
    try {
      await adapter.getSetupStatus();
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderUnavailableError);
      expect((e as Error).cause).toBe(underlying);
    }
  });

  it("includes stderr snippet in error message for non-card method", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "rate limited: too many requests",
      exitCode: 1,
    });
    const adapter = createStripeLinkAdapter({
      clientName: "test",
      testMode: true,
      maxAmountCents: 50000,
      runner,
    });
    await expect(adapter.listFundingSources({})).rejects.toThrow(/rate limited/);
  });

  it("retrieveCardSecrets error message does NOT include stderr (defense-in-depth)", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "card pan is 4242424242424242", // adversarial: stderr with PAN-shaped content
      exitCode: 1,
    });
    const adapter = createStripeLinkAdapter({
      clientName: "test",
      testMode: true,
      maxAmountCents: 50000,
      runner,
    });
    try {
      await adapter.retrieveCardSecrets("lsrq_test_001");
      expect.fail("expected throw");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/4242|pan/i);
      expect((e as Error).message).toMatch(/card no longer available/i);
    }
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

  it("accepts pollIntervalMs and pollMaxAttempts options", () => {
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
