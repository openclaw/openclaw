/**
 * Paper trading tools: fin_paper_create, fin_paper_order, fin_paper_state
 * Basic single-account paper trading for fin-core (open source).
 * Uses fin-paper-engine service if available, otherwise provides a lightweight fallback.
 */
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { json } from "./json-helper.js";

/** Minimal interface for the paper engine service. Avoids circular dependency on fin-paper-trading. */
interface PaperEngineLike {
  createAccount(name: string, capital: number): unknown;
  submitOrder(accountId: string, order: Record<string, unknown>): unknown;
  getAccountState(accountId: string): unknown;
  listAccounts(): unknown[];
}

function getPaperEngine(api: OpenClawPluginApi): PaperEngineLike | undefined {
  return api.runtime.services.get("fin-paper-engine") as PaperEngineLike | undefined;
}

export function registerPaperTools(api: OpenClawPluginApi): void {
  // ── fin_paper_create ──
  api.registerTool(
    {
      name: "fin_paper_create",
      label: "Create Paper Account",
      description:
        "Create a paper trading account with virtual capital. " +
        "Paper accounts simulate real trading without risking real money.",
      parameters: Type.Object({
        name: Type.String({ description: "Account name (e.g. 'crypto-test', 'us-stock-demo')" }),
        capital: Type.Number({ description: "Initial virtual capital in USD" }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const engine = getPaperEngine(api);
          if (!engine) {
            return json({
              success: false,
              error: "Paper trading engine not available. Enable the fin-paper-trading plugin.",
            });
          }

          const account = engine.createAccount(params.name as string, params.capital as number);
          return json({
            success: true,
            message: `Paper account "${params.name}" created with $${params.capital} virtual capital.`,
            account,
          });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_paper_create"] },
  );

  // ── fin_paper_order ──
  api.registerTool(
    {
      name: "fin_paper_order",
      label: "Paper Order",
      description: "Submit a simulated order on a paper trading account.",
      parameters: Type.Object({
        accountId: Type.String({ description: "Paper account ID" }),
        symbol: Type.String({ description: "Trading pair (e.g. 'BTC/USDT', 'AAPL')" }),
        side: Type.Unsafe<"buy" | "sell">({
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side",
        }),
        qty: Type.Number({ description: "Order quantity" }),
        type: Type.Optional(
          Type.Unsafe<"market" | "limit">({
            type: "string",
            enum: ["market", "limit"],
            description: "Order type. Defaults to market.",
          }),
        ),
        price: Type.Optional(Type.Number({ description: "Limit price (required for limit orders)" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const engine = getPaperEngine(api);
          if (!engine) {
            return json({
              success: false,
              error: "Paper trading engine not available. Enable the fin-paper-trading plugin.",
            });
          }

          const result = engine.submitOrder(params.accountId as string, {
            symbol: params.symbol,
            side: params.side,
            qty: params.qty,
            type: params.type ?? "market",
            price: params.price,
          });

          return json({ success: true, order: result });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_paper_order"] },
  );

  // ── fin_paper_state ──
  api.registerTool(
    {
      name: "fin_paper_state",
      label: "Paper Account State",
      description: "View the current state of a paper trading account (balance, positions, PnL).",
      parameters: Type.Object({
        accountId: Type.Optional(
          Type.String({ description: "Paper account ID. If omitted, lists all accounts." }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const engine = getPaperEngine(api);
          if (!engine) {
            return json({
              success: false,
              error: "Paper trading engine not available. Enable the fin-paper-trading plugin.",
            });
          }

          if (params.accountId) {
            const state = engine.getAccountState(params.accountId as string);
            return json({ success: true, account: state });
          }

          const accounts = engine.listAccounts();
          return json({ success: true, accounts });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_paper_state"] },
  );
}
