/**
 * stripe-link.ts — Stripe Link adapter for the OpenClaw payment plugin.
 *
 * Rewritten against link-cli 0.4.0 actual JSON shapes (smoke-tested 2026-05-01).
 *
 * Security invariants (from feature plan U4):
 *
 * 1. `--include card` MUST appear in EXACTLY ONE place: inside `retrieveCardSecrets`.
 *    Any other use is a security defect.
 *
 * 2. MPP token (shared_payment_token) is function-scoped inside `executeMachinePayment`.
 *    It is captured in a `const sharedPaymentToken` local, used for `mpp pay`, and then
 *    goes out of scope when the function returns. It is never stored externally.
 *
 * 3. `CardSecrets` returned from `retrieveCardSecrets` must not be retained in any
 *    module-scope variable, cache, or closure after the function returns.
 *
 * 4. Card data MUST NEVER appear in error messages, log output, or audit records.
 *    Only redacted display values (`brand`, `last4`) are used in errors.
 *
 * Verified link-cli 0.4.0 output shapes:
 *
 * A. `link-cli auth status --format json` returns an ARRAY:
 *    [{ authenticated: boolean, access_token, token_type, credentials_path,
 *       update: { current_version, latest_version, update_command } }]
 *    NOTE: --test flag is NOT valid for auth status (rejected with "Unknown flag").
 *    providerVersion comes from update.current_version.
 *
 * B. `link-cli payment-methods list --format json` returns an ARRAY:
 *    [{ id, type: "CARD", name, is_default, card_details: { brand, last4, exp_month: number, exp_year: number } }]
 *    NOTE: --test flag is NOT valid here. No USDC discriminator in 0.4.0; all items are CARD.
 *    TODO: USDC/stablecoin detection requires a different signal once the CLI exposes it.
 *
 * C. `link-cli spend-request create ... --format json` returns ARRAY with pending_approval
 *    immediately (does NOT block):
 *    [{ id: "lsrq_...", status: "pending_approval", approval_url, _next: { command }, ... }]
 *    id prefix is lsrq_, NOT spreq_.
 *    --test IS valid for spend-request create.
 *
 * D. `link-cli spend-request retrieve <id> --interval 2 --max-attempts 150 --format json`
 *    polls and returns transition snapshots array. Take LAST element as terminal state.
 *    --test IS valid here (per spend-request commands).
 *    NOTE: MPP flow (shared_payment_token) not validated against live link-cli;
 *    smoke-test before V1 ship.
 *
 * E. `link-cli spend-request retrieve <id> --include card --format json` returns array;
 *    one element with card nested object:
 *    [{ id, status: "approved", card: { id, number, cvc, brand, exp_month: number,
 *       exp_year: number, billing_address: { name, ... }, valid_until }, ... }]
 *    NOTE: `--include card` is TWO ARGS (space-separated), NOT `--include=card`.
 *    card.number = PAN, card.cvc = CVV, card.billing_address.name = holder name.
 *    card.valid_until is INSIDE card object, not at top level.
 *
 * F. `link-cli mpp pay --format json ...` — shape not validated against live 0.4.0.
 *    TODO: MPP flow not validated against live link-cli; smoke-test before V1 ship.
 */

import { randomUUID } from "node:crypto";
import { enforceMaxAmount } from "../policy.js";
import { handleMap } from "../store.js";
import type { CredentialHandle, FundingSource, MachinePaymentResult } from "../types.js";
import type {
  BuyerProfile,
  CredentialFillData,
  ExecuteMachinePaymentParams,
  IssueVirtualCardParams,
  ListFundingSourcesParams,
  PaymentProviderAdapter,
  PaymentProviderSetupStatus,
} from "./base.js";
import { CardUnavailableError, PolicyDeniedError, ProviderUnavailableError } from "./base.js";
import type { CommandRunner } from "./runner.js";
import { createNodeCommandRunner } from "./runner.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StripeLinkAdapterOptions = {
  /** Path to the link-cli binary. Defaults to "link-cli" (resolved on PATH). */
  command?: string;
  /** Display name embedded in spend-request creation. From config.providers["stripe-link"].clientName. */
  clientName: string;
  /** If true, append `--test` to commands that support it (spend-request create/retrieve). */
  testMode: boolean;
  /** Hard cap on amounts. Defaults to 50000 cents (Stripe Link's hard cap). */
  maxAmountCents: number;
  /** CommandRunner injected for testing. Defaults to createNodeCommandRunner(). */
  runner?: CommandRunner;
  /**
   * Poll interval for spend-request retrieve. Passed as --interval <n> (seconds).
   * Default: 2 (link-cli recommended value).
   */
  pollIntervalMs?: number;
  /**
   * Max polling attempts for spend-request retrieve. Passed as --max-attempts <n>.
   * Default: 150 (link-cli recommended value = ~5 min total at 2s interval).
   */
  pollMaxAttempts?: number;
  /** Subprocess timeout. Default 60000ms for most calls; 400000ms for polling. */
  commandTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap a link-cli response that may be wrapped in an array.
 * All link-cli 0.4.0 commands return arrays. Take the first element.
 * For polling responses (retrieve with --interval), there may be multiple
 * transition snapshots; callers of poll must use unwrapLastArrayElement instead.
 */
function unwrapArrayResponse<T>(parsed: unknown): T {
  if (Array.isArray(parsed)) {
    return parsed[0] as T;
  }
  return parsed as T;
}

/**
 * For polling retrieve responses: link-cli returns an array of state-transition
 * snapshots. The LAST element is the terminal state.
 */
function unwrapLastArrayElement<T>(parsed: unknown): T {
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed[parsed.length - 1] as T;
  }
  return parsed as T;
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function generateIdempotencyKey(): string {
  return randomUUID();
}

/** Map a link-cli status string to CredentialHandle.status. */
function mapStatus(status: string): CredentialHandle["status"] {
  if (status === "approved") return "approved";
  if (status === "denied") return "denied";
  if (status === "expired") return "expired";
  // pending_approval, pending, or unknown — return pending_approval for re-poll
  return "pending_approval";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStripeLinkAdapter(opts: StripeLinkAdapterOptions): PaymentProviderAdapter {
  const command = opts.command ?? "link-cli";
  const runner: CommandRunner = opts.runner ?? createNodeCommandRunner();
  const commandTimeoutMs = opts.commandTimeoutMs ?? 60_000;
  // Polling timeout: 150 attempts × 2s = 300s, plus headroom
  const pollTimeoutMs = opts.commandTimeoutMs ?? 400_000;
  const pollIntervalSec = 2; // link-cli recommended
  const pollMaxAttempts = opts.pollMaxAttempts ?? 150; // link-cli recommended

  /**
   * Run the CLI command with the given args, capture stdout as JSON.
   * Throws ProviderUnavailableError if the subprocess throws (e.g. ENOENT).
   * Returns { stdout, exitCode } for callers to inspect.
   */
  async function runCli(
    args: string[],
    options?: { input?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      return await runner(command, args, {
        timeoutMs: options?.timeoutMs ?? commandTimeoutMs,
        input: options?.input,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderUnavailableError("stripe-link", msg, { cause: err });
    }
  }

  // ---------------------------------------------------------------------------
  // getSetupStatus
  // ---------------------------------------------------------------------------

  async function getSetupStatus(): Promise<PaymentProviderSetupStatus> {
    // Security: --include card MUST NOT appear in args here.
    // NOTE: --test is NOT valid for auth status (link-cli 0.4.0 rejects it).
    const args = ["auth", "status", "--format", "json"];
    const result = await runCli(args);

    if (result.exitCode !== 0) {
      const reason = opts.testMode
        ? "not authenticated — run `link-cli auth login`"
        : "not authenticated — run `link-cli auth login`";
      return {
        available: false,
        reason,
        authState: "unauthenticated",
        testMode: opts.testMode,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout) as unknown;
    } catch {
      return {
        available: false,
        reason: "link-cli auth status returned non-JSON output",
        authState: "unknown",
        testMode: opts.testMode,
      };
    }

    // link-cli 0.4.0: response is array; unwrap first element
    const parsed = unwrapArrayResponse<Record<string, unknown>>(raw);

    // Verified shape A: field is `authenticated: boolean`
    const isAuthenticated =
      parsed["authenticated"] === true ||
      (typeof parsed["account"] === "object" && parsed["account"] !== null);

    // Version source: update.current_version (shape A)
    const update = parsed["update"] as Record<string, unknown> | undefined;
    const providerVersion =
      typeof update?.["current_version"] === "string"
        ? update["current_version"]
        : typeof parsed["version"] === "string"
          ? parsed["version"]
          : undefined;

    return {
      available: isAuthenticated,
      authState: isAuthenticated ? "authenticated" : "unauthenticated",
      reason: isAuthenticated ? undefined : "not authenticated — run `link-cli auth login`",
      providerVersion,
      testMode: opts.testMode,
    };
  }

  // ---------------------------------------------------------------------------
  // listFundingSources
  // ---------------------------------------------------------------------------

  async function listFundingSources(_params: ListFundingSourcesParams): Promise<FundingSource[]> {
    // Security: --include card MUST NOT appear in args here.
    // NOTE: --test is NOT valid for payment-methods list (link-cli 0.4.0).
    const args = ["payment-methods", "list", "--format", "json"];
    const result = await runCli(args);

    if (result.exitCode !== 0) {
      const stderrSnippet = result.stderr.trim().slice(0, 200);
      const reason = stderrSnippet
        ? `link-cli payment-methods list failed: ${stderrSnippet}`
        : `link-cli payment-methods list failed (exit ${result.exitCode})`;
      throw new ProviderUnavailableError("stripe-link", reason);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error("expected array");
      }
    } catch (err: unknown) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "link-cli payment-methods list returned non-array JSON",
        { cause: err },
      );
    }

    const items = raw as unknown[];

    return items.map((item): FundingSource => {
      const pm = item as Record<string, unknown>;
      const id = String(pm["id"] ?? "");

      // link-cli 0.4.0 shape B: type is "CARD" for all items.
      // card_details contains brand/last4/exp_month (number)/exp_year (number).
      const cardDetails = pm["card_details"] as Record<string, unknown> | undefined;
      const brand =
        cardDetails && typeof cardDetails["brand"] === "string" ? cardDetails["brand"] : undefined;
      const last4 =
        cardDetails && typeof cardDetails["last4"] === "string" ? cardDetails["last4"] : undefined;

      // Use `name` field directly (e.g. "Atmos Rewards Visa Infinite")
      // Fallback to constructed brand+last4 if name absent.
      let displayName = typeof pm["name"] === "string" ? pm["name"] : undefined;
      if (!displayName) {
        displayName = brand && last4 ? `${capitalizeFirst(brand)} ••${last4}` : id;
      }

      // TODO: USDC/stablecoin detection: link-cli 0.4.0 has no USDC discriminator —
      // all items have type: "CARD". When the CLI exposes a stablecoin indicator,
      // use it here to emit ["usdc"] for USDC-settled methods.
      const settlementAssets: FundingSource["settlementAssets"] = ["usd_card"];

      return {
        id,
        provider: "stripe-link",
        // Every Link payment method supports both V1 rails
        rails: ["virtual_card", "machine_payment"],
        settlementAssets,
        displayName,
        // link-cli 0.4.0 does not expose currency or balance at this endpoint
        currency: "usd",
        availableBalanceCents: undefined,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // issueVirtualCard
  //
  // link-cli 0.4.0 flow:
  //   1. spend-request create → returns pending_approval immediately
  //   2. spend-request retrieve <id> --interval 2 --max-attempts 150 → polls; last element = terminal
  //   3. If approved: spend-request retrieve <id> --include card → get full card data
  // ---------------------------------------------------------------------------

  async function issueVirtualCard(params: IssueVirtualCardParams): Promise<CredentialHandle> {
    // Pre-shell-out validation
    if (params.purchaseIntent.length < 100) {
      throw new PolicyDeniedError("purchaseIntent must be at least 100 characters", "stripe-link");
    }

    // Amount cap validation
    enforceMaxAmount(opts.maxAmountCents, params.amount.amountCents);

    // idempotencyKey must be non-empty if supplied
    if (params.idempotencyKey !== undefined && params.idempotencyKey.trim() === "") {
      throw new PolicyDeniedError("idempotencyKey must be non-empty when supplied", "stripe-link");
    }

    // merchant.url is required by link-cli 0.4.0 for credential_type=card
    const merchantUrl = params.merchant.url ?? "https://example.invalid";

    // Step 1: Create spend-request.
    // Security: --include card MUST NOT appear in args here.
    // --test IS valid for spend-request create.
    const createArgs: string[] = [
      "spend-request",
      "create",
      "--format",
      "json",
      "--request-approval",
      "--payment-method-id",
      params.fundingSourceId,
      "--amount",
      String(params.amount.amountCents),
      "--currency",
      params.amount.currency,
      "--merchant-name",
      params.merchant.name,
      "--merchant-url",
      merchantUrl,
      "--context",
      params.purchaseIntent,
    ];
    // NOTE: --client-name and --idempotency-key NOT supported in link-cli 0.4.0
    if (opts.testMode) {
      createArgs.push("--test");
    }

    const createResult = await runCli(createArgs);

    if (createResult.exitCode !== 0) {
      const stderrSnippet = createResult.stderr.trim().slice(0, 200);
      const reason = stderrSnippet
        ? `spend-request create failed: ${stderrSnippet}`
        : `spend-request create failed (exit ${createResult.exitCode})`;
      throw new ProviderUnavailableError("stripe-link", reason);
    }

    let createRaw: unknown;
    try {
      createRaw = JSON.parse(createResult.stdout) as unknown;
    } catch (err: unknown) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create returned non-JSON output",
        { cause: err },
      );
    }

    // link-cli 0.4.0: response is array; unwrap first element
    const created = unwrapArrayResponse<Record<string, unknown>>(createRaw);

    // id prefix is lsrq_ in 0.4.0
    const spendRequestId = String(created["id"] ?? "");
    if (!spendRequestId) {
      throw new ProviderUnavailableError("stripe-link", "spend-request create: missing id field");
    }

    // create always returns pending_approval; we must poll
    // Step 2: Poll with retrieve --interval 2 --max-attempts 150
    const pollArgs: string[] = [
      "spend-request",
      "retrieve",
      spendRequestId,
      "--interval",
      String(pollIntervalSec),
      "--max-attempts",
      String(pollMaxAttempts),
      "--format",
      "json",
    ];
    // Note: --test is NOT a valid flag on `spend-request retrieve`; only on
    // `spend-request create`. The retrieved spend-request inherits its test
    // mode from the create call.

    const pollResult = await runCli(pollArgs, { timeoutMs: pollTimeoutMs });

    let pollRaw: unknown;
    let terminalRecord: Record<string, unknown>;

    if (pollResult.exitCode !== 0) {
      // link-cli non-zero exit on poll could mean max-attempts exhausted (still pending)
      // or a real error. Treat as pending_approval for re-poll via getStatus.
      // We still try to parse in case there's useful data.
      try {
        pollRaw = JSON.parse(pollResult.stdout) as unknown;
        terminalRecord = unwrapLastArrayElement<Record<string, unknown>>(pollRaw);
      } catch {
        // Can't parse — fall through to pending_approval with no card data
        terminalRecord = { id: spendRequestId, status: "pending_approval" };
      }
    } else {
      try {
        pollRaw = JSON.parse(pollResult.stdout) as unknown;
      } catch (err: unknown) {
        throw new ProviderUnavailableError(
          "stripe-link",
          "spend-request retrieve (poll) returned non-JSON output",
          { cause: err },
        );
      }
      // Take LAST element as terminal state
      terminalRecord = unwrapLastArrayElement<Record<string, unknown>>(pollRaw);
    }

    const terminalStatus = String(terminalRecord["status"] ?? "pending_approval");
    const handleStatus = mapStatus(terminalStatus);

    const handleId = `slh-${spendRequestId}`;

    // Step 3: If approved, fetch card display data (no PAN/CVV — just brand/last4/exp)
    // The card display comes from a second retrieve WITH --include card.
    let displayBrand: string | undefined;
    let displayLast4: string | undefined;
    let displayExpMonth: string | undefined;
    let displayExpYear: string | undefined;
    let validUntil: string | undefined;

    if (terminalStatus === "approved") {
      // Security: --include card appears ONLY here, inside retrieveCardSecrets and this step.
      // WAIT — per security invariant, --include card must appear in EXACTLY ONE place.
      // Per plan: "valid_until source: from the second retrieve's card.valid_until"
      // and "display fields: from second retrieve's card.brand, card.last4, etc."
      // The second retrieve uses --include card. But security invariant says ONLY in retrieveCardSecrets.
      //
      // Resolution: We fetch display-only data from the approved terminal record if available,
      // OR we defer display population to the fill hook's retrieveCardSecrets call.
      // The --include card path stays EXCLUSIVELY in retrieveCardSecrets.
      //
      // For issueVirtualCard, we do NOT call --include card here.
      // Display data will be populated when retrieveCardSecrets is called by the fill hook.
      // validUntil is not available without --include card — leave undefined.
      //
      // This keeps the security invariant intact: --include card in ONLY ONE place.
      //
      // Note: If the adapter needs display data at issue time (for the handle),
      // a follow-up can add a display-only retrieve path that does NOT expose PAN/CVV.
      // For V1, leave display as undefined for the "approved" case from polling.
      void 0; // no --include card here
    }

    const display: CredentialHandle["display"] =
      displayBrand || displayLast4
        ? {
            brand: displayBrand,
            last4: displayLast4,
            expMonth: displayExpMonth,
            expYear: displayExpYear,
          }
        : undefined;

    const fillSentinels: CredentialHandle["fillSentinels"] = {
      pan: { $paymentHandle: handleId, field: "pan" },
      cvv: { $paymentHandle: handleId, field: "cvv" },
      exp_month: { $paymentHandle: handleId, field: "exp_month" },
      exp_year: { $paymentHandle: handleId, field: "exp_year" },
      exp_mm_yy: { $paymentHandle: handleId, field: "exp_mm_yy" },
      exp_mm_yyyy: { $paymentHandle: handleId, field: "exp_mm_yyyy" },
      holder_name: { $paymentHandle: handleId, field: "holder_name" },
      billing_line1: { $paymentHandle: handleId, field: "billing_line1" },
      billing_city: { $paymentHandle: handleId, field: "billing_city" },
      billing_state: { $paymentHandle: handleId, field: "billing_state" },
      billing_postal_code: { $paymentHandle: handleId, field: "billing_postal_code" },
      billing_country: { $paymentHandle: handleId, field: "billing_country" },
    };

    const handle: CredentialHandle = {
      id: handleId,
      provider: "stripe-link",
      rail: "virtual_card",
      status: handleStatus,
      providerRequestId: spendRequestId,
      validUntil,
      display,
      fillSentinels,
    };

    // Populate handleMap with non-sensitive metadata.
    handleMap.set(handleId, {
      spendRequestId,
      providerId: "stripe-link",
      last4: displayLast4,
      targetMerchantName: params.merchant.name,
      issuedAt: new Date().toISOString(),
      validUntil,
    });

    return handle;
  }

  // ---------------------------------------------------------------------------
  // retrieveCardSecrets
  //
  // SECURITY: This is the ONLY method where --include card appears.
  // Do not add --include card to any other method.
  // ---------------------------------------------------------------------------

  async function retrieveCardSecrets(spendRequestId: string): Promise<CredentialFillData> {
    // SECURITY: --include card is intentional here and ONLY here.
    // Note: "card" is a separate arg (not --include=card): ["--include", "card"]
    const args: string[] = [
      "spend-request",
      "retrieve",
      spendRequestId,
      "--include",
      "card",
      "--format",
      "json",
    ];
    // Note: --test is NOT a valid flag on `spend-request retrieve`; the
    // retrieved spend-request inherits its test mode from the create call.

    const result = await runCli(args);

    if (result.exitCode !== 0) {
      // Defense-in-depth: do NOT include any field of the failed JSON in the error message,
      // even though Stripe shouldn't return PAN on a failed retrieve.
      throw new CardUnavailableError(
        undefined,
        "card no longer available — issue a new spend request",
        "stripe-link",
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout) as unknown;
    } catch {
      // Do NOT include stdout in this error — it might contain card data.
      throw new CardUnavailableError(
        undefined,
        "card no longer available — issue a new spend request",
        "stripe-link",
      );
    }

    // link-cli 0.4.0: response is array; unwrap first element
    // Shape E: { id, status, card: { id, number, cvc, brand, exp_month, exp_year,
    //            billing_address: { name, ... }, valid_until }, ... }
    const record = unwrapArrayResponse<Record<string, unknown>>(raw);
    const card = record["card"] as Record<string, unknown> | undefined;

    if (!card) {
      throw new CardUnavailableError(
        undefined,
        "card no longer available — issue a new spend request",
        "stripe-link",
      );
    }

    const pan = typeof card["number"] === "string" ? card["number"] : undefined;
    const cvv = typeof card["cvc"] === "string" ? card["cvc"] : undefined;

    if (!pan || !cvv) {
      throw new CardUnavailableError(
        undefined,
        "card no longer available — issue a new spend request",
        "stripe-link",
      );
    }

    const expMonthRaw = card["exp_month"];
    const expYearRaw = card["exp_year"];
    const expMonth =
      typeof expMonthRaw === "number"
        ? String(expMonthRaw).padStart(2, "0")
        : String(expMonthRaw ?? "");
    const expYear = typeof expYearRaw === "number" ? String(expYearRaw) : String(expYearRaw ?? "");

    // Derive combined expiry fields (for single-field MM/YY forms such as Stripe Elements).
    // expYear is always the full 4-digit string (e.g. "2030"). We take the last 2 digits
    // for expMmYy. Edge case: if expYear is somehow already 2 digits, use it verbatim.
    const yy = expYear.length >= 2 ? expYear.slice(-2) : expYear.padStart(2, "0");
    const expMmYy = `${expMonth}/${yy}`;
    const expMmYyyy = `${expMonth}/${expYear}`;

    // Billing address fields from billing_address (link-cli 0.4.0 shape E).
    // We extract structurally into BuyerProfile.billing — leaving them undefined when
    // absent rather than empty strings, so the fill-hook resolver can give a clear
    // "field not available" error instead of substituting an empty string silently.
    const billingAddress = card["billing_address"] as Record<string, unknown> | undefined;
    const holderName =
      typeof billingAddress?.["name"] === "string" ? billingAddress["name"] : undefined;

    // Forward-compat passthrough for additional non-secret fields the provider may
    // expose. Stripe team has indicated link-cli will soon return email, phone,
    // shipping_*. When that lands, the agent can use those field names immediately
    // without any code changes here.
    //
    // SECURITY: We only pass through STRING values at the top level. Nested objects,
    // numbers, booleans are excluded — defense-in-depth against accidental
    // pass-through of object-typed secrets we don't recognize (e.g., a hypothetical
    // `card.tokenization_metadata: { token: "secret" }`). Adapters are also
    // responsible for excluding any string fields that are themselves card-secret;
    // the KNOWN_CARD_FIELDS allow-list below enumerates fields we extract structurally.
    const KNOWN_CARD_FIELDS = new Set([
      "id",
      "number",
      "cvc",
      "brand",
      "exp_month",
      "exp_year",
      "billing_address",
      "valid_until",
      "cardholder_name",
    ]);
    const KNOWN_BILLING_FIELDS = new Set([
      "name",
      "line1",
      "city",
      "state",
      "postal_code",
      "country",
    ]);

    const extras: Record<string, string> = {};

    // Top-level card fields not captured structurally — strings only.
    for (const [k, v] of Object.entries(card)) {
      if (KNOWN_CARD_FIELDS.has(k)) continue;
      if (typeof v === "string") {
        extras[k] = v;
      }
      // Non-string values are intentionally dropped (defense-in-depth).
    }

    // billing_address sub-fields not captured structurally — strings only,
    // namespaced with `billing_` prefix to match the FillSentinel field convention.
    if (billingAddress) {
      for (const [k, v] of Object.entries(billingAddress)) {
        if (KNOWN_BILLING_FIELDS.has(k)) continue;
        if (typeof v === "string") {
          extras[`billing_${k}`] = v;
        }
      }
    }

    const billing =
      billingAddress !== undefined
        ? {
            line1:
              typeof billingAddress["line1"] === "string" ? billingAddress["line1"] : undefined,
            city: typeof billingAddress["city"] === "string" ? billingAddress["city"] : undefined,
            state:
              typeof billingAddress["state"] === "string" ? billingAddress["state"] : undefined,
            postalCode:
              typeof billingAddress["postal_code"] === "string"
                ? billingAddress["postal_code"]
                : undefined,
            country:
              typeof billingAddress["country"] === "string" ? billingAddress["country"] : undefined,
          }
        : undefined;

    const profile: BuyerProfile = {
      holderName,
      billing,
      extras,
    };

    // SECURITY: Return the secrets + profile. Do NOT log. Do NOT cache in module scope.
    // The caller (U6 fill hook) must drop the reference after substitution.
    return {
      secrets: {
        pan,
        cvv,
        expMonth,
        expYear,
        expMmYy,
        expMmYyyy,
      },
      profile,
    };
  }

  // ---------------------------------------------------------------------------
  // executeMachinePayment
  //
  // Two-step flow:
  //   1. Create a spend-request with --credential-type=shared_payment_token, poll until approved
  //   2. Pass the token (via stdin) to `mpp pay`
  //
  // TODO: MPP flow not validated against live link-cli 0.4.0; smoke-test before V1 ship.
  //       The --include card and polling pattern here mirrors the virtual_card flow
  //       but the shared_payment_token shape in the poll response is unverified.
  //
  // SECURITY: The MPP token is captured in a function-scoped `const sharedPaymentToken`.
  // It is used only for step 2. It goes out of scope when this function returns.
  // It is never stored in module state, instance state, handleMap, or error messages.
  // ---------------------------------------------------------------------------

  async function executeMachinePayment(
    params: ExecuteMachinePaymentParams,
  ): Promise<MachinePaymentResult> {
    // idempotencyKey must be non-empty if supplied
    if (params.idempotencyKey !== undefined && params.idempotencyKey.trim() === "") {
      throw new PolicyDeniedError("idempotencyKey must be non-empty when supplied", "stripe-link");
    }

    // Step 1: Create a spend-request for the machine payment token.
    // Security: --include card MUST NOT appear in args here.
    const createArgs: string[] = [
      "spend-request",
      "create",
      "--format",
      "json",
      "--credential-type=shared_payment_token",
      "--request-approval",
      "--payment-method-id",
      params.fundingSourceId,
      "--context",
      params.targetUrl,
      "--merchant-url",
      params.targetUrl,
      "--merchant-name",
      params.targetUrl,
    ];
    if (opts.testMode) {
      createArgs.push("--test");
    }

    const createResult = await runCli(createArgs);

    if (createResult.exitCode !== 0) {
      const stderrSnippet = createResult.stderr.trim().slice(0, 200);
      const reason = stderrSnippet
        ? `spend-request create (MPP) failed: ${stderrSnippet}`
        : `spend-request create (MPP) failed (exit ${createResult.exitCode})`;
      throw new ProviderUnavailableError("stripe-link", reason);
    }

    let createRaw: unknown;
    try {
      createRaw = JSON.parse(createResult.stdout) as unknown;
    } catch (err: unknown) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create (MPP) returned non-JSON output",
        { cause: err },
      );
    }

    const created = unwrapArrayResponse<Record<string, unknown>>(createRaw);
    const spendRequestId = String(created["id"] ?? "");
    if (!spendRequestId) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create (MPP): missing id field",
      );
    }

    // Poll for approval (same as virtual_card flow)
    const pollArgs: string[] = [
      "spend-request",
      "retrieve",
      spendRequestId,
      "--interval",
      String(pollIntervalSec),
      "--max-attempts",
      String(pollMaxAttempts),
      "--format",
      "json",
    ];
    // Note: --test is NOT valid on `spend-request retrieve`; only on `create`.

    const pollResult = await runCli(pollArgs, { timeoutMs: pollTimeoutMs });

    let pollRaw: unknown;
    try {
      pollRaw = JSON.parse(pollResult.stdout) as unknown;
    } catch (err: unknown) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request retrieve (MPP poll) returned non-JSON output",
        { cause: err },
      );
    }

    const terminalRecord = unwrapLastArrayElement<Record<string, unknown>>(pollRaw);
    const mppStatus = String(terminalRecord["status"] ?? "");

    if (mppStatus !== "approved") {
      throw new ProviderUnavailableError(
        "stripe-link",
        `spend-request for MPP not approved (status: ${mppStatus})`,
      );
    }

    // SECURITY: The shared payment token is captured here in a function-scoped const.
    // It is used only for the mpp pay call below. It goes out of scope at function return.
    // Do NOT store this token in module state, instance state, or the returned result.
    const sharedPaymentToken = String(terminalRecord["shared_payment_token"] ?? "");

    if (!sharedPaymentToken) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request retrieve (MPP): missing shared_payment_token in approved record",
      );
    }

    // Step 2: Execute the machine payment via mpp pay.
    // Token delivery strategy: pass via stdin using --token-stdin if link-cli supports it.
    // This avoids process listing exposure.
    // TODO: MPP mpp pay flow not validated against live link-cli 0.4.0; smoke-test before V1 ship.
    // Security: --include card MUST NOT appear in args here.
    const payArgs: string[] = [
      "mpp",
      "pay",
      "--format",
      "json",
      "--token-stdin",
      "--target",
      params.targetUrl,
      "--method",
      params.method,
    ];
    if (opts.testMode) {
      payArgs.push("--test");
    }

    if (params.body !== undefined) {
      payArgs.push("--body", JSON.stringify(params.body));
    }

    const payResult = await runCli(payArgs, { input: sharedPaymentToken });
    // sharedPaymentToken local has been used; function will return shortly.
    // The token is not referenced again after this point.

    if (payResult.exitCode !== 0) {
      const stderrSnippet = payResult.stderr.trim().slice(0, 200);
      const reason = stderrSnippet
        ? `mpp pay failed: ${stderrSnippet}`
        : `mpp pay failed (exit ${payResult.exitCode})`;
      throw new ProviderUnavailableError("stripe-link", reason);
    }

    let payParsed: Record<string, unknown>;
    try {
      payParsed = JSON.parse(payResult.stdout) as Record<string, unknown>;
    } catch (err: unknown) {
      throw new ProviderUnavailableError("stripe-link", "mpp pay returned non-JSON output", {
        cause: err,
      });
    }

    // TODO: mpp pay response shape not validated against live link-cli 0.4.0.
    // Using assumed shape: { result: { outcome, status_code, receipt_id, issued_at } }
    const resultData = payParsed["result"] as Record<string, unknown> | undefined;
    if (!resultData) {
      throw new ProviderUnavailableError("stripe-link", "mpp pay: missing result field");
    }

    const outcomeRaw = String(resultData["outcome"] ?? "");
    const outcome: MachinePaymentResult["outcome"] =
      outcomeRaw === "settled" ? "settled" : outcomeRaw === "failed" ? "failed" : "pending";

    const statusCode =
      typeof resultData["status_code"] === "number" ? resultData["status_code"] : undefined;
    const receiptId =
      typeof resultData["receipt_id"] === "string" ? resultData["receipt_id"] : undefined;
    const issuedAt =
      typeof resultData["issued_at"] === "string"
        ? resultData["issued_at"]
        : new Date().toISOString();

    const handleId = `slm-${spendRequestId}`;

    return {
      handleId,
      targetUrl: params.targetUrl,
      outcome,
      receipt: {
        receiptId,
        issuedAt,
        statusCode,
      },
    };
    // sharedPaymentToken goes out of scope here — no retention.
  }

  // ---------------------------------------------------------------------------
  // getStatus
  // ---------------------------------------------------------------------------

  async function getStatus(handleId: string): Promise<CredentialHandle> {
    const meta = handleMap.get(handleId);
    if (!meta) {
      throw new CardUnavailableError(handleId, "unknown handle", "stripe-link");
    }

    const spendRequestId = meta.spendRequestId;

    // Security: --include card MUST NOT appear in args here.
    // Note: --test is NOT valid on `spend-request retrieve`; only on `create`.
    const args: string[] = ["spend-request", "retrieve", spendRequestId, "--format", "json"];

    const result = await runCli(args);

    if (result.exitCode !== 0) {
      throw new CardUnavailableError(handleId, "spend-request no longer available", "stripe-link");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout) as unknown;
    } catch (err: unknown) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request retrieve returned non-JSON output",
        { cause: err },
      );
    }

    // For getStatus (non-polling retrieve), take last element in case multiple snapshots
    const record = unwrapLastArrayElement<Record<string, unknown>>(raw);

    const status = String(record["status"] ?? "");
    const handleStatus = mapStatus(status);

    // validUntil: not available without --include card in 0.4.0; fall back to stored value
    const validUntil = meta.validUntil;

    const display: CredentialHandle["display"] = { last4: meta.last4 };

    const fillSentinels: CredentialHandle["fillSentinels"] = {
      pan: { $paymentHandle: handleId, field: "pan" },
      cvv: { $paymentHandle: handleId, field: "cvv" },
      exp_month: { $paymentHandle: handleId, field: "exp_month" },
      exp_year: { $paymentHandle: handleId, field: "exp_year" },
      exp_mm_yy: { $paymentHandle: handleId, field: "exp_mm_yy" },
      exp_mm_yyyy: { $paymentHandle: handleId, field: "exp_mm_yyyy" },
      holder_name: { $paymentHandle: handleId, field: "holder_name" },
      billing_line1: { $paymentHandle: handleId, field: "billing_line1" },
      billing_city: { $paymentHandle: handleId, field: "billing_city" },
      billing_state: { $paymentHandle: handleId, field: "billing_state" },
      billing_postal_code: { $paymentHandle: handleId, field: "billing_postal_code" },
      billing_country: { $paymentHandle: handleId, field: "billing_country" },
    };

    return {
      id: handleId,
      provider: "stripe-link",
      rail: "virtual_card",
      status: handleStatus,
      providerRequestId: spendRequestId,
      validUntil,
      display,
      fillSentinels,
    };
  }

  // ---------------------------------------------------------------------------
  // Adapter object
  // ---------------------------------------------------------------------------

  return {
    id: "stripe-link",
    rails: ["virtual_card", "machine_payment"],
    getSetupStatus,
    listFundingSources,
    issueVirtualCard,
    retrieveCardSecrets,
    executeMachinePayment,
    getStatus,
  };
}
