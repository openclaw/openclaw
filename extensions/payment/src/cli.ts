/**
 * cli.ts — `openclaw payment` CLI subcommand registration.
 *
 * Subcommands:
 *   openclaw payment setup [--provider <id>] [--json]
 *   openclaw payment funding list [--provider <id>] [--json]
 *   openclaw payment virtual-card issue --provider <id> --funding-source <fs-id>
 *     --amount <cents> --currency <cur> --merchant-name <name>
 *     --purchase-intent <text> [--idempotency-key <key>] [--yes] [--json]
 *   openclaw payment execute --provider <id> --funding-source <fs-id>
 *     --target-url <url> --method <verb> [--data <json>]
 *     [--idempotency-key <key>] [--yes] [--json]
 *   openclaw payment status --handle-id <id> [--json]
 *
 * Dry-run behavior:
 *   - `virtual-card issue` and `execute` print a dry-run summary and exit 0
 *     UNLESS --yes is supplied.
 *   - setup, funding list, status are read-only and have no --yes gate.
 */

import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PaymentManager } from "./payments.js";
import { redactHandle, redactMachinePaymentResult } from "./redact.js";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function writeLine(message: string): void {
  process.stdout.write(message + "\n");
}

function writeError(message: string): void {
  process.stderr.write(message + "\n");
}

// ---------------------------------------------------------------------------
// Strict integer parsing (Codex P2-4)
// ---------------------------------------------------------------------------

/**
 * Parse a CLI string as a strict positive integer.
 * Rejects decimals ("12.99"), suffixed strings ("100abc"), empty strings,
 * zero, negatives, and overflow values.
 * Throws an Error with a descriptive message on failure.
 */
function parseStrictInt(s: string, fieldName: string): number {
  if (!/^\d+$/.test(s)) {
    throw new Error(`${fieldName} must be a positive integer (no decimals, no suffix); got "${s}"`);
  }
  const n = Number.parseInt(s, 10);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${fieldName} must be a positive integer; got "${s}"`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// registerPaymentCli
// ---------------------------------------------------------------------------

export function registerPaymentCli(api: OpenClawPluginApi, manager: PaymentManager): void {
  api.registerCli(
    async ({ program }) => {
      buildPaymentCli(program, manager);
    },
    {
      commands: ["payment"],
      descriptors: [
        {
          name: "payment",
          description: "Manage OpenClaw payment plugin (Stripe Link + mock)",
          hasSubcommands: true,
        },
      ],
    },
  );
}

// ---------------------------------------------------------------------------
// CLI builder — exported for testing
// ---------------------------------------------------------------------------

export function buildPaymentCli(program: Command, manager: PaymentManager): void {
  const payment = program
    .command("payment")
    .description("Manage OpenClaw payment plugin (Stripe Link + mock providers)");

  // -------------------------------------------------------------------------
  // openclaw payment setup
  // -------------------------------------------------------------------------

  payment
    .command("setup")
    .description("Check payment provider setup status")
    .option("--provider <id>", "Provider id (stripe-link | mock)")
    .option("--json", "Emit machine-readable JSON to stdout")
    .action(async (opts: { provider?: string; json?: boolean }) => {
      try {
        const providerId =
          opts.provider === "stripe-link" || opts.provider === "mock" ? opts.provider : undefined;
        const status = await manager.getSetupStatus(providerId);
        if (opts.json) {
          writeJson({ status });
        } else {
          writeLine(`Provider: ${opts.provider ?? "default"}`);
          writeLine(`Available: ${status.available}`);
          if (status.reason) writeLine(`Reason: ${status.reason}`);
          if (status.authState) writeLine(`Auth state: ${status.authState}`);
          if (status.providerVersion) writeLine(`Version: ${status.providerVersion}`);
          if (status.testMode !== undefined) writeLine(`Test mode: ${status.testMode}`);
        }
      } catch (err) {
        writeError(`payment setup error: ${String(err)}`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // openclaw payment funding list
  // -------------------------------------------------------------------------

  const funding = payment.command("funding").description("Funding source management");

  funding
    .command("list")
    .description("List available funding sources")
    .option("--provider <id>", "Provider id (stripe-link | mock)")
    .option("--json", "Emit machine-readable JSON to stdout")
    .action(async (opts: { provider?: string; json?: boolean }) => {
      try {
        const providerId =
          opts.provider === "stripe-link" || opts.provider === "mock" ? opts.provider : undefined;
        const sources = await manager.listFundingSources(
          providerId !== undefined ? { providerId } : {},
        );
        if (opts.json) {
          writeJson({ sources });
        } else {
          if (sources.length === 0) {
            writeLine("No funding sources found.");
          } else {
            for (const src of sources) {
              writeLine(
                `${src.id}  ${src.displayName}  [${src.rails.join(", ")}]${src.currency ? `  ${src.currency.toUpperCase()}` : ""}`,
              );
            }
          }
        }
      } catch (err) {
        writeError(`payment funding list error: ${String(err)}`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // openclaw payment virtual-card issue
  // -------------------------------------------------------------------------

  const virtualCard = payment.command("virtual-card").description("Virtual card management");

  virtualCard
    .command("issue")
    .description("Issue a single-use virtual card (requires --yes to proceed)")
    .requiredOption("--provider <id>", "Provider id (stripe-link | mock)")
    .requiredOption("--funding-source <fs-id>", "Funding source id")
    .requiredOption("--amount <cents>", "Amount in cents (integer >= 1)")
    .requiredOption("--currency <cur>", "Currency code (e.g. usd)")
    .requiredOption("--merchant-name <name>", "Merchant name")
    .requiredOption("--purchase-intent <text>", "Purchase intent (>=100 chars)")
    .option("--merchant-url <url>", "Merchant URL")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--yes", "Confirm and proceed (required for live issuance)")
    .option("--json", "Emit machine-readable JSON to stdout")
    .action(
      async (opts: {
        provider: string;
        fundingSource: string;
        amount: string;
        currency: string;
        merchantName: string;
        purchaseIntent: string;
        merchantUrl?: string;
        idempotencyKey?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        let amountCents: number;
        try {
          amountCents = parseStrictInt(opts.amount, "--amount");
        } catch (err) {
          writeError(`payment virtual-card issue: ${String(err)}`);
          process.exit(1);
        }

        if (opts.purchaseIntent.length < 100) {
          writeError(
            `payment virtual-card issue: --purchase-intent must be at least 100 characters (got ${opts.purchaseIntent.length})`,
          );
          process.exit(1);
        }

        if (opts.provider !== "stripe-link" && opts.provider !== "mock") {
          writeError(
            `payment virtual-card issue: --provider must be "stripe-link" or "mock" (got "${opts.provider}")`,
          );
          process.exit(1);
        }

        // Dry-run (no --yes)
        if (!opts.yes) {
          const summary = {
            action: "issue_virtual_card",
            dryRun: true,
            provider: opts.provider,
            fundingSource: opts.fundingSource,
            amountCents,
            currency: opts.currency,
            merchantName: opts.merchantName,
            purchaseIntent: opts.purchaseIntent.slice(0, 60) + "...",
          };
          if (opts.json) {
            writeJson(summary);
          } else {
            writeLine("[DRY RUN] Would issue virtual card:");
            writeLine(`  Provider:       ${opts.provider}`);
            writeLine(`  Funding source: ${opts.fundingSource}`);
            writeLine(`  Amount:         ${amountCents} cents (${opts.currency.toUpperCase()})`);
            writeLine(`  Merchant:       ${opts.merchantName}`);
            writeLine("");
            writeLine("Run with --yes to proceed with actual issuance.");
          }
          return;
        }

        // Live issuance
        try {
          const handle = await manager.issueVirtualCard({
            providerId: opts.provider as "stripe-link" | "mock",
            fundingSourceId: opts.fundingSource,
            amount: { amountCents, currency: opts.currency },
            merchant: {
              name: opts.merchantName,
              ...(opts.merchantUrl !== undefined ? { url: opts.merchantUrl } : {}),
            },
            purchaseIntent: opts.purchaseIntent,
            ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
          });

          const redacted = redactHandle(handle);

          if (opts.json) {
            writeJson({ handle: redacted });
          } else {
            writeLine(`Issued virtual card: ${handle.id}`);
            writeLine(`Status: ${handle.status}`);
            if (handle.display?.last4) writeLine(`Card: ...${handle.display.last4}`);
            if (handle.validUntil) writeLine(`Valid until: ${handle.validUntil}`);
          }
        } catch (err) {
          writeError(`payment virtual-card issue error: ${String(err)}`);
          process.exit(1);
        }
      },
    );

  // -------------------------------------------------------------------------
  // openclaw payment execute
  // -------------------------------------------------------------------------

  payment
    .command("execute")
    .description("Execute a machine payment (requires --yes to proceed)")
    .requiredOption("--provider <id>", "Provider id (stripe-link | mock)")
    .requiredOption("--funding-source <fs-id>", "Funding source id")
    .requiredOption("--target-url <url>", "Target URL for payment API")
    .requiredOption("--method <verb>", "HTTP method (GET | POST | PUT | PATCH | DELETE)")
    .option("--data <json>", "JSON body (optional)")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--yes", "Confirm and proceed (required for live execution)")
    .option("--json", "Emit machine-readable JSON to stdout")
    .action(
      async (opts: {
        provider: string;
        fundingSource: string;
        targetUrl: string;
        method: string;
        data?: string;
        idempotencyKey?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];

        if (opts.provider !== "stripe-link" && opts.provider !== "mock") {
          writeError(
            `payment execute: --provider must be "stripe-link" or "mock" (got "${opts.provider}")`,
          );
          process.exit(1);
        }

        const method = opts.method.toUpperCase();
        if (!validMethods.includes(method)) {
          writeError(
            `payment execute: --method must be one of ${validMethods.join(", ")} (got "${opts.method}")`,
          );
          process.exit(1);
        }

        // Parse --data early (before dry-run / --yes branch) so malformed JSON
        // surfaces immediately regardless of whether --yes is present.
        let body: unknown;
        if (opts.data !== undefined) {
          try {
            body = JSON.parse(opts.data);
          } catch {
            writeError("payment execute: --data must be valid JSON");
            process.exit(1);
          }
        }

        // Dry-run (no --yes)
        if (!opts.yes) {
          const bodyDisplay =
            body === undefined
              ? "no body"
              : (() => {
                  const s = JSON.stringify(body);
                  return s.length > 500 ? `${s.slice(0, 500)}... (truncated)` : s;
                })();
          const summary = {
            action: "execute_machine_payment",
            dryRun: true,
            provider: opts.provider,
            fundingSource: opts.fundingSource,
            targetUrl: opts.targetUrl,
            method,
            body: body,
          };
          if (opts.json) {
            writeJson(summary);
          } else {
            writeLine("[DRY RUN] Would execute machine payment:");
            writeLine(`  Provider:       ${opts.provider}`);
            writeLine(`  Funding source: ${opts.fundingSource}`);
            writeLine(`  Target URL:     ${opts.targetUrl}`);
            writeLine(`  Method:         ${method}`);
            writeLine(`  Body:           ${bodyDisplay}`);
            writeLine("");
            writeLine("Run with --yes to proceed with actual execution.");
          }
          return;
        }

        // Live execution
        try {
          const result = await manager.executeMachinePayment({
            providerId: opts.provider as "stripe-link" | "mock",
            fundingSourceId: opts.fundingSource,
            targetUrl: opts.targetUrl,
            method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
            ...(body !== undefined ? { body } : {}),
            ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
          });

          const redacted = redactMachinePaymentResult(result);

          if (opts.json) {
            writeJson({ result: redacted });
          } else {
            writeLine(`Machine payment: ${result.handleId}`);
            writeLine(`Outcome: ${result.outcome}`);
            if (result.receipt?.statusCode !== undefined) {
              writeLine(`Status code: ${result.receipt.statusCode}`);
            }
          }
        } catch (err) {
          writeError(`payment execute error: ${String(err)}`);
          process.exit(1);
        }
      },
    );

  // -------------------------------------------------------------------------
  // openclaw payment status
  // -------------------------------------------------------------------------

  payment
    .command("status")
    .description("Get status of an issued payment handle")
    .requiredOption("--handle-id <id>", "Handle id returned by issue_virtual_card")
    .option("--json", "Emit machine-readable JSON to stdout")
    .action(async (opts: { handleId: string; json?: boolean }) => {
      try {
        const handle = await manager.getStatus(opts.handleId);
        const redacted = redactHandle(handle);

        if (opts.json) {
          writeJson({ handle: redacted });
        } else {
          writeLine(`Handle: ${handle.id}`);
          writeLine(`Status: ${handle.status}`);
          if (handle.display?.last4) writeLine(`Card: ...${handle.display.last4}`);
          if (handle.validUntil) writeLine(`Valid until: ${handle.validUntil}`);
        }
      } catch (err) {
        writeError(`payment status error: ${String(err)}`);
        process.exit(1);
      }
    });
}
