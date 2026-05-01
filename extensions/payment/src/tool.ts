/**
 * tool.ts — `payment` agent tool registration.
 *
 * Action union (V1):
 *   setup_status        — read-only, no approval
 *   list_funding_sources — read-only, no approval
 *   issue_virtual_card  — money-moving, requires approval (severity: warning)
 *   execute_machine_payment — money-moving + irreversible, requires approval (severity: critical)
 *   get_payment_status  — read-only, no approval
 *
 * Security invariants:
 *   - No PAN, CVV, expiry, or MPP token in any tool result.
 *   - fillSentinels returned for issue_virtual_card are safe reference objects —
 *     they contain only sentinel keys, not real card data.
 *   - retrieveCardSecretsForHook is NEVER called from this file.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PaymentManager } from "./payments.js";
import type { CredentialHandle, MachinePaymentResult } from "./types.js";

// ---------------------------------------------------------------------------
// TypeBox action schemas
// ---------------------------------------------------------------------------

const ProviderIdSchema = Type.Union([Type.Literal("stripe-link"), Type.Literal("mock")]);

const SetupStatusInput = Type.Object({
  action: Type.Literal("setup_status"),
  providerId: Type.Optional(ProviderIdSchema),
});

const ListFundingSourcesInput = Type.Object({
  action: Type.Literal("list_funding_sources"),
  providerId: Type.Optional(ProviderIdSchema),
});

const IssueVirtualCardInput = Type.Object({
  action: Type.Literal("issue_virtual_card"),
  providerId: ProviderIdSchema,
  fundingSourceId: Type.String({ minLength: 1 }),
  amount: Type.Object({
    amountCents: Type.Integer({ minimum: 1 }),
    currency: Type.String({ minLength: 1 }),
  }),
  merchant: Type.Object({
    name: Type.String({ minLength: 1 }),
    url: Type.Optional(Type.String()),
    countryCode: Type.Optional(Type.String()),
    category: Type.Optional(Type.String()),
    mcc: Type.Optional(Type.String()),
  }),
  purchaseIntent: Type.String({ minLength: 100 }),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
});

const ExecuteMachinePaymentInput = Type.Object({
  action: Type.Literal("execute_machine_payment"),
  providerId: ProviderIdSchema,
  fundingSourceId: Type.String({ minLength: 1 }),
  targetUrl: Type.String({ minLength: 1 }),
  method: Type.Union([
    Type.Literal("GET"),
    Type.Literal("POST"),
    Type.Literal("PUT"),
    Type.Literal("PATCH"),
    Type.Literal("DELETE"),
  ]),
  body: Type.Optional(Type.Unknown()),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
});

const GetPaymentStatusInput = Type.Object({
  action: Type.Literal("get_payment_status"),
  handleId: Type.String({ minLength: 1 }),
});

export const PaymentToolInput = Type.Union([
  SetupStatusInput,
  ListFundingSourcesInput,
  IssueVirtualCardInput,
  ExecuteMachinePaymentInput,
  GetPaymentStatusInput,
]);

export type PaymentToolInputType = Static<typeof PaymentToolInput>;

// ---------------------------------------------------------------------------
// Result helpers — strip secrets before returning
// ---------------------------------------------------------------------------

/**
 * Redact a CredentialHandle to remove any PAN/CVV/token fields.
 * Only safe display fields + fillSentinels are included.
 */
function redactHandle(handle: CredentialHandle): CredentialHandle {
  return {
    id: handle.id,
    provider: handle.provider,
    rail: handle.rail,
    status: handle.status,
    ...(handle.providerRequestId !== undefined
      ? { providerRequestId: handle.providerRequestId }
      : {}),
    ...(handle.validUntil !== undefined ? { validUntil: handle.validUntil } : {}),
    ...(handle.display !== undefined ? { display: handle.display } : {}),
    // fillSentinels are safe — they contain only sentinel keys, no card data
    ...(handle.fillSentinels !== undefined ? { fillSentinels: handle.fillSentinels } : {}),
  };
}

/**
 * Redact a MachinePaymentResult to remove any sensitive token fields.
 */
function redactMachinePaymentResult(result: MachinePaymentResult): MachinePaymentResult {
  return {
    handleId: result.handleId,
    targetUrl: result.targetUrl,
    outcome: result.outcome,
    ...(result.receipt !== undefined ? { receipt: result.receipt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Handler dispatch
// ---------------------------------------------------------------------------

async function handlePaymentTool(
  params: unknown,
  manager: PaymentManager,
): Promise<AgentToolResult<unknown>> {
  const input = params as PaymentToolInputType;

  switch (input.action) {
    case "setup_status": {
      const status = await manager.getSetupStatus(input.providerId);
      const text = JSON.stringify({ action: "setup_status", status }, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { status },
      };
    }

    case "list_funding_sources": {
      const sources = await manager.listFundingSources(
        input.providerId !== undefined ? { providerId: input.providerId } : {},
      );
      const text = JSON.stringify({ action: "list_funding_sources", sources }, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { sources },
      };
    }

    case "issue_virtual_card": {
      const handle = await manager.issueVirtualCard({
        providerId: input.providerId,
        fundingSourceId: input.fundingSourceId,
        amount: input.amount,
        merchant: input.merchant,
        purchaseIntent: input.purchaseIntent,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      });

      const redacted = redactHandle(handle);
      const fillSentinels = redacted.fillSentinels;
      const usageHint =
        "Pass these sentinel values into the `browser.act` tool's `fill` action. " +
        "The payment plugin will substitute real card values inside the `before_tool_call` " +
        "hook with explicit user approval.";

      const details = {
        handle: redacted,
        fillSentinels,
        usageHint,
      };
      const text = JSON.stringify(
        { action: "issue_virtual_card", handle: redacted, fillSentinels, usageHint },
        null,
        2,
      );
      return {
        content: [{ type: "text", text }],
        details,
      };
    }

    case "execute_machine_payment": {
      const result = await manager.executeMachinePayment({
        providerId: input.providerId,
        fundingSourceId: input.fundingSourceId,
        targetUrl: input.targetUrl,
        method: input.method,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      });

      const redacted = redactMachinePaymentResult(result);
      const text = JSON.stringify({ action: "execute_machine_payment", result: redacted }, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { result: redacted },
      };
    }

    case "get_payment_status": {
      const handle = await manager.getStatus(input.handleId);
      const redacted = redactHandle(handle);
      const text = JSON.stringify({ action: "get_payment_status", handle: redacted }, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { handle: redacted },
      };
    }

    default: {
      const _exhaustive: never = input;
      void _exhaustive;
      throw new Error(`Unknown payment action`);
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPaymentTool(api: OpenClawPluginApi, manager: PaymentManager): void {
  api.registerTool({
    name: "payment",
    label: "Payment",
    description: [
      "Manage payments via the OpenClaw payment plugin.",
      "Actions: setup_status (check provider availability), list_funding_sources (list payment methods),",
      "issue_virtual_card (issue a single-use virtual card — requires approval),",
      "execute_machine_payment (execute an HTTP payment — requires approval),",
      "get_payment_status (check status of an issued handle).",
      "Money-moving actions (issue_virtual_card, execute_machine_payment) require explicit user approval before execution.",
    ].join(" "),
    parameters: PaymentToolInput,
    execute: async (_toolCallId, params, _signal) => {
      return handlePaymentTool(params, manager);
    },
  });
}
