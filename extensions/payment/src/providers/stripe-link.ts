/**
 * stripe-link.ts — Stripe Link adapter for the OpenClaw payment plugin.
 *
 * Security invariants (from feature plan U4):
 *
 * 1. `--include=card` MUST appear in EXACTLY ONE place: inside `retrieveCardSecrets`.
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
 * Assumptions about link-cli output shape (to be verified during U6 acceptance):
 *
 * A. `link-cli auth status --format json` returns `{ authenticated: boolean, account: ..., version: string }`.
 *    We check `parsed.authenticated === true` for the auth state.
 *
 * B. `link-cli payment-methods list --format json` returns a JSON array of objects.
 *    Each has: `id`, `funding_source_type` (e.g. "card" or "stablecoin"), `card.brand`,
 *    `card.last4`, `currency`, `available_balance_cents`, `display_name`.
 *
 * C. `link-cli spend-request create --format json ...` returns `{ spend_request: { id, status,
 *    valid_until, card: { brand, last4, exp_month, exp_year } } }`.
 *    Statuses: "approved", "denied", "pending", "expired".
 *
 * D. `link-cli spend-request retrieve --format json --include=card <id>` returns the same shape
 *    but `card.number` contains the PAN and `card.cvc` contains the CVV.
 *    Without `--include=card`, `card.number` and `card.cvc` are absent.
 *
 * E. `link-cli spend-request create --credential-type=shared_payment_token ...` returns
 *    `{ spend_request: { id, status, shared_payment_token: "spt_..." } }`.
 *
 * F. `link-cli mpp pay --format json ...` returns `{ result: { outcome, status_code,
 *    receipt_id, issued_at, target_url } }`. Outcomes: "settled", "failed", "pending".
 *
 * G. MPP token is passed via stdin (`--token-stdin`) when available. V1 falls back to
 *    a CLI arg `--token <token>` with a documented process-listing leak risk if
 *    link-cli does not support `--token-stdin`.
 *    JUDGMENT CALL: We pass the token via the `input` (stdin) option of the CommandRunner
 *    and use `--token-stdin` as the flag. This avoids process listing exposure entirely.
 *    If link-cli does not support `--token-stdin`, U6 acceptance will surface this and
 *    a fallback to env-var (`STRIPE_LINK_MPP_TOKEN`) should be considered over CLI args.
 *
 * H. `--request-approval` causes link-cli to block until the spend request reaches a
 *    terminal state (approved/denied/expired). The adapter does NOT implement its own
 *    polling loop; it relies on link-cli's built-in polling via this flag. If link-cli
 *    times out internally, it exits non-zero and the adapter surfaces a ProviderUnavailableError.
 */

import { randomUUID } from "node:crypto";
import { enforceMaxAmount } from "../policy.js";
import { handleMap } from "../store.js";
import type { CredentialHandle, FundingSource, MachinePaymentResult } from "../types.js";
import type {
  CardSecrets,
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
  /** If true, append `--test` to commands that support it. */
  testMode: boolean;
  /** Hard cap on amounts. Defaults to 50000 cents (Stripe Link's hard cap). */
  maxAmountCents: number;
  /** CommandRunner injected for testing. Defaults to createNodeCommandRunner(). */
  runner?: CommandRunner;
  /**
   * Reserved for future use. V1 delegates approval polling to link-cli's
   * built-in `--request-approval` flag, so this option is currently
   * accepted but not consulted. Default: 1000ms.
   */
  pollIntervalMs?: number;
  /**
   * Reserved for future use (see pollIntervalMs). V1 delegates polling.
   * Default: 120 (would yield ~2min total at 1s cadence if polling were enabled).
   */
  pollMaxAttempts?: number;
  /** Subprocess timeout. Default 60000. */
  commandTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStripeLinkAdapter(opts: StripeLinkAdapterOptions): PaymentProviderAdapter {
  const command = opts.command ?? "link-cli";
  const runner: CommandRunner = opts.runner ?? createNodeCommandRunner();
  const commandTimeoutMs = opts.commandTimeoutMs ?? 60_000;
  // reserved — V1 delegates polling to link-cli's --request-approval flag
  const pollIntervalMs = opts.pollIntervalMs ?? 1000; // reserved
  const pollMaxAttempts = opts.pollMaxAttempts ?? 120; // reserved
  void pollIntervalMs;
  void pollMaxAttempts;

  /** Append --test flag to args array when testMode is enabled. */
  function maybeTest(args: string[]): string[] {
    if (opts.testMode) {
      return [...args, "--test"];
    }
    return args;
  }

  /**
   * Run the CLI command with the given args, capture stdout as JSON.
   * Throws ProviderUnavailableError if the subprocess throws (e.g. ENOENT).
   * Returns { stdout, exitCode } for callers to inspect.
   */
  async function runCli(
    args: string[],
    options?: { input?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      return await runner(command, args, {
        timeoutMs: commandTimeoutMs,
        input: options?.input,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderUnavailableError("stripe-link", msg);
    }
  }

  // ---------------------------------------------------------------------------
  // getSetupStatus
  // ---------------------------------------------------------------------------

  async function getSetupStatus(): Promise<PaymentProviderSetupStatus> {
    // Security: --include=card MUST NOT appear in args here.
    const args = maybeTest(["auth", "status", "--format", "json"]);
    const result = await runCli(args);

    if (result.exitCode !== 0) {
      const reason = opts.testMode
        ? "not authenticated — run `link-cli auth login --test`"
        : "not authenticated — run `link-cli auth login`";
      return {
        available: false,
        reason,
        authState: "unauthenticated",
        testMode: opts.testMode,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return {
        available: false,
        reason: "link-cli auth status returned non-JSON output",
        authState: "unknown",
        testMode: opts.testMode,
      };
    }

    // Assumption A: field is `authenticated: boolean`
    const isAuthenticated =
      parsed["authenticated"] === true ||
      (typeof parsed["account"] === "object" && parsed["account"] !== null);

    // Assumption A: version is at `version` field
    const providerVersion = typeof parsed["version"] === "string" ? parsed["version"] : undefined;

    return {
      available: isAuthenticated,
      authState: isAuthenticated ? "authenticated" : "unauthenticated",
      reason: isAuthenticated
        ? undefined
        : opts.testMode
          ? "not authenticated — run `link-cli auth login --test`"
          : "not authenticated — run `link-cli auth login`",
      providerVersion,
      testMode: opts.testMode,
    };
  }

  // ---------------------------------------------------------------------------
  // listFundingSources
  // ---------------------------------------------------------------------------

  async function listFundingSources(_params: ListFundingSourcesParams): Promise<FundingSource[]> {
    // Security: --include=card MUST NOT appear in args here.
    const args = maybeTest(["payment-methods", "list", "--format", "json"]);
    const result = await runCli(args);

    if (result.exitCode !== 0) {
      throw new ProviderUnavailableError("stripe-link", "link-cli payment-methods list failed");
    }

    let parsed: unknown[];
    try {
      const raw = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error("expected array");
      }
      parsed = raw;
    } catch {
      throw new ProviderUnavailableError(
        "stripe-link",
        "link-cli payment-methods list returned non-array JSON",
      );
    }

    return parsed.map((item): FundingSource => {
      const pm = item as Record<string, unknown>;
      const id = String(pm["id"] ?? "");
      const currency = typeof pm["currency"] === "string" ? pm["currency"] : "usd";
      const availableBalanceCents =
        typeof pm["available_balance_cents"] === "number"
          ? pm["available_balance_cents"]
          : undefined;

      // Assumption B: funding_source_type === "stablecoin" means USDC settlement
      const isStablecoin = pm["funding_source_type"] === "stablecoin";
      const settlementAssets: FundingSource["settlementAssets"] = isStablecoin
        ? ["usdc"]
        : ["usd_card"];

      // Derive display name from card info or use provided display_name
      let displayName = typeof pm["display_name"] === "string" ? pm["display_name"] : id;
      const card = pm["card"] as Record<string, unknown> | undefined;
      if (card && typeof card["brand"] === "string" && typeof card["last4"] === "string") {
        const brand = capitalizeFirst(card["brand"]);
        displayName = `${brand} •• ${card["last4"]}`;
      }

      return {
        id,
        provider: "stripe-link",
        // Every Link payment method supports both V1 rails
        rails: ["virtual_card", "machine_payment"],
        settlementAssets,
        displayName,
        currency,
        availableBalanceCents,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // issueVirtualCard
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

    const idempotencyKey = params.idempotencyKey ?? generateIdempotencyKey();

    // Security: --include=card MUST NOT appear in args here.
    // DO NOT add --include=card here — card retrieval happens only in retrieveCardSecrets.
    const args = maybeTest([
      "spend-request",
      "create",
      "--format",
      "json",
      "--request-approval",
      "--client-name",
      opts.clientName,
      "--payment-method",
      params.fundingSourceId,
      "--amount",
      String(params.amount.amountCents),
      "--currency",
      params.amount.currency,
      "--merchant-name",
      params.merchant.name,
      "--context",
      params.purchaseIntent,
      "--idempotency-key",
      idempotencyKey,
    ]);

    const result = await runCli(args);

    if (result.exitCode !== 0) {
      throw new ProviderUnavailableError("stripe-link", "spend-request create failed");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create returned non-JSON output",
      );
    }

    // Assumption C: shape is { spend_request: { id, status, valid_until, card: {...} } }
    const sr = parsed["spend_request"] as Record<string, unknown> | undefined;
    if (!sr) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create: missing spend_request field",
      );
    }

    const spendRequestId = String(sr["id"] ?? "");
    const status = String(sr["status"] ?? "");
    const validUntil = typeof sr["valid_until"] === "string" ? sr["valid_until"] : undefined;

    // Map Stripe status to CredentialHandle status
    let handleStatus: CredentialHandle["status"];
    if (status === "approved") {
      handleStatus = "approved";
    } else if (status === "denied") {
      handleStatus = "denied";
    } else if (status === "expired") {
      handleStatus = "expired";
    } else {
      // pending or unknown: return pending_approval so the manager can re-poll via getStatus
      handleStatus = "pending_approval";
    }

    // Extract redacted card display (no PAN, no CVV — just brand/last4/exp)
    const card = sr["card"] as Record<string, unknown> | null | undefined;
    const display: CredentialHandle["display"] = card
      ? {
          brand: typeof card["brand"] === "string" ? card["brand"] : undefined,
          last4: typeof card["last4"] === "string" ? card["last4"] : undefined,
          expMonth:
            typeof card["exp_month"] === "number"
              ? String(card["exp_month"]).padStart(2, "0")
              : typeof card["exp_month"] === "string"
                ? card["exp_month"]
                : undefined,
          expYear:
            typeof card["exp_year"] === "number"
              ? String(card["exp_year"])
              : typeof card["exp_year"] === "string"
                ? card["exp_year"]
                : undefined,
        }
      : undefined;

    const handleId = `slh-${spendRequestId}`;

    const fillSentinels: CredentialHandle["fillSentinels"] = {
      pan: { $paymentHandle: handleId, field: "pan" },
      cvv: { $paymentHandle: handleId, field: "cvv" },
      exp_month: { $paymentHandle: handleId, field: "exp_month" },
      exp_year: { $paymentHandle: handleId, field: "exp_year" },
      holder_name: { $paymentHandle: handleId, field: "holder_name" },
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
    // Note: last4 is a display value, not a secret.
    handleMap.set(handleId, {
      spendRequestId,
      providerId: "stripe-link",
      last4: display?.last4,
      targetMerchantName: params.merchant.name,
      issuedAt: new Date().toISOString(),
      validUntil,
    });

    return handle;
  }

  // ---------------------------------------------------------------------------
  // retrieveCardSecrets
  //
  // SECURITY: This is the ONLY method where --include=card appears.
  // Do not add --include=card to any other method.
  // ---------------------------------------------------------------------------

  async function retrieveCardSecrets(spendRequestId: string): Promise<CardSecrets> {
    // SECURITY: --include=card is intentional here and ONLY here.
    const args = maybeTest([
      "spend-request",
      "retrieve",
      "--format",
      "json",
      "--include=card",
      spendRequestId,
    ]);

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

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      // Do NOT include stdout in this error — it might contain card data.
      throw new CardUnavailableError(
        undefined,
        "card no longer available — issue a new spend request",
        "stripe-link",
      );
    }

    // Assumption D: shape is { spend_request: { card: { number, cvc, exp_month, exp_year, cardholder_name } } }
    const sr = parsed["spend_request"] as Record<string, unknown> | undefined;
    const card = (sr?.["card"] ?? parsed["card"]) as Record<string, unknown> | undefined;

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

    const holderName =
      typeof card["cardholder_name"] === "string" ? card["cardholder_name"] : "OPENCLAW VIRTUAL";

    // SECURITY: Return the secrets. Do NOT log. Do NOT cache in module scope.
    // The caller (U6 fill hook) must drop the reference after substitution.
    return {
      pan,
      cvv,
      expMonth,
      expYear,
      holderName,
    };
  }

  // ---------------------------------------------------------------------------
  // executeMachinePayment
  //
  // Two-step flow:
  //   1. Create a spend-request with credential_type=shared_payment_token
  //   2. Pass the token (via stdin) to `mpp pay`
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

    const idempotencyKey = params.idempotencyKey ?? generateIdempotencyKey();

    // Step 1: Create a spend-request for the machine payment token.
    // Security: --include=card MUST NOT appear in args here.
    const createArgs = maybeTest([
      "spend-request",
      "create",
      "--format",
      "json",
      "--credential-type=shared_payment_token",
      "--request-approval",
      "--client-name",
      opts.clientName,
      "--payment-method",
      params.fundingSourceId,
      "--context",
      params.targetUrl,
      "--idempotency-key",
      idempotencyKey,
    ]);

    const createResult = await runCli(createArgs);

    if (createResult.exitCode !== 0) {
      throw new ProviderUnavailableError("stripe-link", "spend-request create (MPP) failed");
    }

    let createParsed: Record<string, unknown>;
    try {
      createParsed = JSON.parse(createResult.stdout) as Record<string, unknown>;
    } catch {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create (MPP) returned non-JSON output",
      );
    }

    // Assumption E: { spend_request: { id, status, shared_payment_token } }
    const sr = createParsed["spend_request"] as Record<string, unknown> | undefined;
    if (!sr) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create (MPP): missing spend_request field",
      );
    }

    const mppStatus = String(sr["status"] ?? "");
    if (mppStatus !== "approved") {
      throw new ProviderUnavailableError(
        "stripe-link",
        `spend-request for MPP not approved (status: ${mppStatus})`,
      );
    }

    const spendRequestId = String(sr["id"] ?? "");

    // SECURITY: The shared payment token is captured here in a function-scoped const.
    // It is used only for the mpp pay call below. It goes out of scope at function return.
    // Do NOT store this token in module state, instance state, or the returned result.
    const sharedPaymentToken = String(sr["shared_payment_token"] ?? "");

    if (!sharedPaymentToken) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request create (MPP): missing shared_payment_token",
      );
    }

    // Step 2: Execute the machine payment via mpp pay.
    // Token delivery strategy: pass via stdin using --token-stdin if link-cli supports it.
    // This avoids process listing exposure (passing token as a CLI arg would be visible
    // to `ps aux` on the system). If link-cli does not support --token-stdin, U6 acceptance
    // testing will surface this; the fallback would be an env-var (STRIPE_LINK_MPP_TOKEN)
    // rather than a CLI arg.
    // Security: --include=card MUST NOT appear in args here.
    const payArgs: string[] = maybeTest([
      "mpp",
      "pay",
      "--format",
      "json",
      "--token-stdin",
      "--target",
      params.targetUrl,
      "--method",
      params.method,
      "--idempotency-key",
      idempotencyKey,
    ]);

    if (params.body !== undefined) {
      payArgs.push("--body", JSON.stringify(params.body));
    }

    const payResult = await runCli(payArgs, { input: sharedPaymentToken });
    // sharedPaymentToken local has been used; function will return shortly.
    // The token is not referenced again after this point.

    if (payResult.exitCode !== 0) {
      throw new ProviderUnavailableError("stripe-link", "mpp pay failed");
    }

    let payParsed: Record<string, unknown>;
    try {
      payParsed = JSON.parse(payResult.stdout) as Record<string, unknown>;
    } catch {
      throw new ProviderUnavailableError("stripe-link", "mpp pay returned non-JSON output");
    }

    // Assumption F: { result: { outcome, status_code, receipt_id, issued_at, target_url } }
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

    // Security: --include=card MUST NOT appear in args here.
    const args = maybeTest(["spend-request", "retrieve", "--format", "json", spendRequestId]);

    const result = await runCli(args);

    if (result.exitCode !== 0) {
      throw new CardUnavailableError(handleId, "spend-request no longer available", "stripe-link");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request retrieve returned non-JSON output",
      );
    }

    const sr = parsed["spend_request"] as Record<string, unknown> | undefined;
    if (!sr) {
      throw new ProviderUnavailableError(
        "stripe-link",
        "spend-request retrieve: missing spend_request field",
      );
    }

    const status = String(sr["status"] ?? "");
    const validUntil = typeof sr["valid_until"] === "string" ? sr["valid_until"] : meta.validUntil;

    let handleStatus: CredentialHandle["status"];
    if (status === "approved") {
      handleStatus = "approved";
    } else if (status === "denied") {
      handleStatus = "denied";
    } else if (status === "expired") {
      handleStatus = "expired";
    } else {
      handleStatus = "pending_approval";
    }

    const card = sr["card"] as Record<string, unknown> | null | undefined;
    const display: CredentialHandle["display"] = card
      ? {
          brand: typeof card["brand"] === "string" ? card["brand"] : undefined,
          last4: typeof card["last4"] === "string" ? card["last4"] : meta.last4,
          expMonth:
            typeof card["exp_month"] === "number"
              ? String(card["exp_month"]).padStart(2, "0")
              : typeof card["exp_month"] === "string"
                ? card["exp_month"]
                : undefined,
          expYear:
            typeof card["exp_year"] === "number"
              ? String(card["exp_year"])
              : typeof card["exp_year"] === "string"
                ? card["exp_year"]
                : undefined,
        }
      : { last4: meta.last4 };

    const fillSentinels: CredentialHandle["fillSentinels"] = {
      pan: { $paymentHandle: handleId, field: "pan" },
      cvv: { $paymentHandle: handleId, field: "cvv" },
      exp_month: { $paymentHandle: handleId, field: "exp_month" },
      exp_year: { $paymentHandle: handleId, field: "exp_year" },
      holder_name: { $paymentHandle: handleId, field: "holder_name" },
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function generateIdempotencyKey(): string {
  return randomUUID();
}
