/**
 * approvals.test.ts — before_tool_call hook shape tests.
 *
 * Verifies:
 *   - Read-only actions return void (no requireApproval).
 *   - issue_virtual_card returns requireApproval with severity "warning", title "Issue virtual card".
 *   - execute_machine_payment returns requireApproval with severity "critical".
 *   - Both money-moving actions have timeoutBehavior "deny".
 *   - Hook is scoped to toolName === "payment" only.
 *   - describeIssueApproval / describeExecuteApproval helper output matches spec.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  describeIssueApproval,
  describeExecuteApproval,
  registerPaymentApprovalsHook,
} from "./approvals.js";

// ---------------------------------------------------------------------------
// Hook extraction helper
// ---------------------------------------------------------------------------

function extractHookHandler(
  api: OpenClawPluginApi,
): (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => unknown {
  let _handler: any = null;
  const fakeApi = {
    on: (hookName: string, handler: any) => {
      if (hookName === "before_tool_call") {
        _handler = handler;
      }
    },
  } as unknown as OpenClawPluginApi;
  registerPaymentApprovalsHook(fakeApi);

  void api; // not used after registration
  return _handler!;
}

function makeHandler() {
  let _handler: any = null;
  const fakeApi = {
    on: (hookName: string, handler: any) => {
      if (hookName === "before_tool_call") {
        _handler = handler;
      }
    },
  } as unknown as OpenClawPluginApi;
  registerPaymentApprovalsHook(fakeApi);
  return _handler as (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => unknown;
}

const FAKE_CTX: PluginHookToolContext = {
  toolName: "payment",
};

function makeEvent(
  toolName: string,
  params: Record<string, unknown>,
): PluginHookBeforeToolCallEvent {
  return { toolName, params };
}

// ---------------------------------------------------------------------------
// Read-only actions — no approval
// ---------------------------------------------------------------------------

describe("before_tool_call hook — read-only actions return void", () => {
  const handler = makeHandler();

  it("returns void for setup_status", () => {
    const result = handler(makeEvent("payment", { action: "setup_status" }), FAKE_CTX);
    expect(result).toBeUndefined();
  });

  it("returns void for list_funding_sources", () => {
    const result = handler(makeEvent("payment", { action: "list_funding_sources" }), FAKE_CTX);
    expect(result).toBeUndefined();
  });

  it("returns void for get_payment_status", () => {
    const result = handler(
      makeEvent("payment", { action: "get_payment_status", handleId: "h1" }),
      FAKE_CTX,
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-payment tool — hook returns void (does not gate other tools)
// ---------------------------------------------------------------------------

describe("before_tool_call hook — returns void for non-payment tools", () => {
  const handler = makeHandler();

  it("returns void for toolName 'browser'", () => {
    const result = handler(
      makeEvent("browser", {
        action: "issue_virtual_card",
        providerId: "mock",
      }),
      { toolName: "browser" },
    );
    expect(result).toBeUndefined();
  });

  it("returns void for toolName 'bash'", () => {
    const result = handler(makeEvent("bash", { command: "ls" }), { toolName: "bash" });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// issue_virtual_card — requires approval
// ---------------------------------------------------------------------------

describe("before_tool_call hook — issue_virtual_card", () => {
  const handler = makeHandler();

  const issueParams = {
    action: "issue_virtual_card",
    providerId: "stripe-link",
    fundingSourceId: "card-001",
    amount: { amountCents: 500, currency: "usd" },
    merchant: { name: "Acme Corp", url: "https://acme.example" },
    purchaseIntent: "A".repeat(120),
  };

  it("returns requireApproval for issue_virtual_card", () => {
    const result = handler(makeEvent("payment", issueParams), FAKE_CTX) as any;
    expect(result).toBeDefined();
    expect(result.requireApproval).toBeDefined();
  });

  it("severity is 'warning' for issue_virtual_card", () => {
    const result = handler(makeEvent("payment", issueParams), FAKE_CTX) as any;
    expect(result.requireApproval.severity).toBe("warning");
  });

  it("title contains 'Issue virtual card'", () => {
    const result = handler(makeEvent("payment", issueParams), FAKE_CTX) as any;
    expect(result.requireApproval.title).toContain("Issue virtual card");
  });

  it("description mentions provider", () => {
    const result = handler(makeEvent("payment", issueParams), FAKE_CTX) as any;
    expect(result.requireApproval.description).toContain("stripe-link");
  });

  it("description mentions amount and currency", () => {
    const result = handler(makeEvent("payment", issueParams), FAKE_CTX) as any;
    expect(result.requireApproval.description).toContain("5.00");
    expect(result.requireApproval.description).toContain("USD");
  });

  it("description mentions merchant name", () => {
    const result = handler(makeEvent("payment", issueParams), FAKE_CTX) as any;
    expect(result.requireApproval.description).toContain("Acme Corp");
  });

  it("timeoutBehavior is 'deny'", () => {
    const result = handler(makeEvent("payment", issueParams), FAKE_CTX) as any;
    expect(result.requireApproval.timeoutBehavior).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// execute_machine_payment — requires approval
// ---------------------------------------------------------------------------

describe("before_tool_call hook — execute_machine_payment", () => {
  const handler = makeHandler();

  const executeParams = {
    action: "execute_machine_payment",
    providerId: "stripe-link",
    fundingSourceId: "card-001",
    targetUrl: "https://example.com/api/pay",
    method: "POST",
  };

  it("returns requireApproval for execute_machine_payment", () => {
    const result = handler(makeEvent("payment", executeParams), FAKE_CTX) as any;
    expect(result).toBeDefined();
    expect(result.requireApproval).toBeDefined();
  });

  it("severity is 'critical' for execute_machine_payment", () => {
    const result = handler(makeEvent("payment", executeParams), FAKE_CTX) as any;
    expect(result.requireApproval.severity).toBe("critical");
  });

  it("title contains 'Execute machine payment'", () => {
    const result = handler(makeEvent("payment", executeParams), FAKE_CTX) as any;
    expect(result.requireApproval.title).toContain("Execute machine payment");
  });

  it("description contains 'irreversible'", () => {
    const result = handler(makeEvent("payment", executeParams), FAKE_CTX) as any;
    expect(result.requireApproval.description).toContain("irreversible");
  });

  it("description contains provider, targetUrl, method", () => {
    const result = handler(makeEvent("payment", executeParams), FAKE_CTX) as any;
    expect(result.requireApproval.description).toContain("stripe-link");
    expect(result.requireApproval.description).toContain("https://example.com/api/pay");
    expect(result.requireApproval.description).toContain("POST");
  });

  it("timeoutBehavior is 'deny'", () => {
    const result = handler(makeEvent("payment", executeParams), FAKE_CTX) as any;
    expect(result.requireApproval.timeoutBehavior).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// describeIssueApproval helper
// ---------------------------------------------------------------------------

describe("describeIssueApproval helper", () => {
  it("includes provider, amount, currency, merchant name", () => {
    const desc = describeIssueApproval({
      providerId: "stripe-link",
      amount: { amountCents: 500, currency: "usd" },
      merchant: { name: "Acme Corp", url: "https://acme.example" },
      fundingSourceId: "card-001",
    });
    expect(desc).toContain("stripe-link");
    expect(desc).toContain("5.00");
    expect(desc).toContain("USD");
    expect(desc).toContain("Acme Corp");
    expect(desc).toContain("https://acme.example");
    expect(desc).toContain("card-001");
  });

  it("works without merchant url", () => {
    const desc = describeIssueApproval({
      providerId: "mock",
      amount: { amountCents: 1000, currency: "eur" },
      merchant: { name: "Widget Co" },
      fundingSourceId: "fs-xyz",
    });
    expect(desc).toContain("Widget Co");
    expect(desc).toContain("10.00");
    expect(desc).toContain("EUR");
    expect(desc).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// describeExecuteApproval helper
// ---------------------------------------------------------------------------

describe("describeExecuteApproval helper", () => {
  it("includes provider, targetUrl, method, fundingSourceId, and 'irreversible'", () => {
    const desc = describeExecuteApproval({
      providerId: "stripe-link",
      targetUrl: "https://example.com/api/pay",
      method: "POST",
      fundingSourceId: "card-001",
    });
    expect(desc).toContain("stripe-link");
    expect(desc).toContain("https://example.com/api/pay");
    expect(desc).toContain("POST");
    expect(desc).toContain("card-001");
    expect(desc).toContain("irreversible");
  });
});

// ---------------------------------------------------------------------------
// registerPaymentApprovalsHook integration
// ---------------------------------------------------------------------------

describe("registerPaymentApprovalsHook integration", () => {
  it("calls api.on with 'before_tool_call'", () => {
    let capturedHookName: string | null = null;
    const fakeApi = {
      on: (hookName: string, _handler: unknown) => {
        capturedHookName = hookName;
      },
    } as unknown as OpenClawPluginApi;
    registerPaymentApprovalsHook(fakeApi);
    expect(capturedHookName).toBe("before_tool_call");
  });
});
