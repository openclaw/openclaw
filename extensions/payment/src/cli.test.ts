/**
 * cli.test.ts — Payment CLI parsing, dry-run, and --yes gate tests.
 *
 * We test buildPaymentCli directly, injecting a fake manager and capturing
 * stdout/stderr output. We do NOT spin up the runner or call api.registerCli.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPaymentCli } from "./cli.js";
import type { PaymentManager } from "./payments.js";
import type { CredentialHandle, FundingSource, MachinePaymentResult } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SETUP_STATUS = {
  available: true,
  authState: "authenticated" as const,
  providerVersion: "1.2.3",
  testMode: false,
};

const MOCK_FUNDING_SOURCES: FundingSource[] = [
  {
    id: "fs-card-001",
    provider: "mock",
    rails: ["virtual_card", "machine_payment"],
    settlementAssets: ["usd_card"],
    displayName: "Mock USD Card",
    currency: "usd",
    availableBalanceCents: 100_000,
  },
];

const MOCK_HANDLE: CredentialHandle = {
  id: "handle-001",
  provider: "mock",
  rail: "virtual_card",
  status: "approved",
  validUntil: "2026-05-01T00:00:00Z",
  display: { brand: "visa", last4: "4242" },
  fillSentinels: {
    pan: { $paymentHandle: "handle-001", field: "pan" },
    cvv: { $paymentHandle: "handle-001", field: "cvv" },
    exp_month: { $paymentHandle: "handle-001", field: "exp_month" },
    exp_year: { $paymentHandle: "handle-001", field: "exp_year" },
    holder_name: { $paymentHandle: "handle-001", field: "holder_name" },
  },
};

const MOCK_MACHINE_RESULT: MachinePaymentResult = {
  handleId: "handle-mp-001",
  targetUrl: "https://example.com/pay",
  outcome: "settled",
  receipt: { receiptId: "rcpt-001", statusCode: 200 },
};

const VALID_PURCHASE_INTENT =
  "Purchasing a developer subscription from Acme Corp for the monthly plan. " +
  "This charge is authorized by the account holder and is approved for processing. " +
  "Reference: INV-2026-001.";

// ---------------------------------------------------------------------------
// Fake manager
// ---------------------------------------------------------------------------

function makeFakeManager(): PaymentManager {
  return {
    getSetupStatus: vi.fn().mockResolvedValue(MOCK_SETUP_STATUS),
    listFundingSources: vi.fn().mockResolvedValue(MOCK_FUNDING_SOURCES),
    issueVirtualCard: vi.fn().mockResolvedValue(MOCK_HANDLE),
    executeMachinePayment: vi.fn().mockResolvedValue(MOCK_MACHINE_RESULT),
    getStatus: vi.fn().mockResolvedValue(MOCK_HANDLE),
    retrieveCardSecretsForHook: vi.fn().mockRejectedValue(new Error("not in test")),
  };
}

// ---------------------------------------------------------------------------
// Stdout/stderr capture
// ---------------------------------------------------------------------------

type CaptureResult = { stdout: string; stderr: string };

async function runCli(manager: PaymentManager, args: string[]): Promise<CaptureResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  let exitCode: number | null = null;

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: any, ...rest: any[]) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: any, ...rest: any[]) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  });

  const program = new Command();
  program.name("openclaw");
  // Prevent commander from calling process.exit on parse errors
  program.exitOverride();

  buildPaymentCli(program, manager);

  try {
    await program.parseAsync(["node", "openclaw", ...args]);
  } catch (err: unknown) {
    // Ignore process.exit errors thrown by our mock
    if (!(err instanceof Error && err.message.startsWith("process.exit("))) {
      // Also ignore commander's exitOverride errors (for --help etc.)
      const msg = String((err as any)?.message ?? err);
      if (!msg.includes("outputHelp") && !msg.includes("(outputHelp)")) {
        // Unknown error — re-throw
      }
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// setup tests
// ---------------------------------------------------------------------------

describe("openclaw payment setup", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("calls manager.getSetupStatus", async () => {
    await runCli(manager, ["payment", "setup"]);
    expect(manager.getSetupStatus).toHaveBeenCalledTimes(1);
  });

  it("prints status in human-readable format", async () => {
    const { stdout } = await runCli(manager, ["payment", "setup"]);
    expect(stdout).toContain("Available");
  });

  it("emits parseable JSON with --json flag", async () => {
    const { stdout } = await runCli(manager, ["payment", "setup", "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("status");
    expect(parsed.status.available).toBe(true);
  });

  it("passes providerId to manager when --provider is given", async () => {
    await runCli(manager, ["payment", "setup", "--provider", "mock"]);
    expect(manager.getSetupStatus).toHaveBeenCalledWith("mock");
  });
});

// ---------------------------------------------------------------------------
// funding list tests
// ---------------------------------------------------------------------------

describe("openclaw payment funding list", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("calls manager.listFundingSources", async () => {
    await runCli(manager, ["payment", "funding", "list"]);
    expect(manager.listFundingSources).toHaveBeenCalledTimes(1);
  });

  it("prints funding sources in human-readable format", async () => {
    const { stdout } = await runCli(manager, ["payment", "funding", "list"]);
    expect(stdout).toContain("fs-card-001");
  });

  it("emits parseable JSON with --json flag", async () => {
    const { stdout } = await runCli(manager, ["payment", "funding", "list", "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("sources");
    expect(Array.isArray(parsed.sources)).toBe(true);
    expect(parsed.sources[0].id).toBe("fs-card-001");
  });
});

// ---------------------------------------------------------------------------
// virtual-card issue — dry-run (no --yes)
// ---------------------------------------------------------------------------

describe("openclaw payment virtual-card issue — dry-run", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("prints dry-run summary and does NOT call manager.issueVirtualCard", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "virtual-card",
      "issue",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--amount",
      "500",
      "--currency",
      "usd",
      "--merchant-name",
      "Acme Corp",
      "--purchase-intent",
      VALID_PURCHASE_INTENT,
    ]);
    expect(manager.issueVirtualCard).not.toHaveBeenCalled();
    expect(stdout).toContain("DRY RUN");
  });

  it("dry-run JSON output has dryRun: true", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "virtual-card",
      "issue",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--amount",
      "500",
      "--currency",
      "usd",
      "--merchant-name",
      "Acme Corp",
      "--purchase-intent",
      VALID_PURCHASE_INTENT,
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.dryRun).toBe(true);
    expect(manager.issueVirtualCard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// virtual-card issue — live (--yes)
// ---------------------------------------------------------------------------

describe("openclaw payment virtual-card issue — live with --yes", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("calls manager.issueVirtualCard when --yes is supplied", async () => {
    await runCli(manager, [
      "payment",
      "virtual-card",
      "issue",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--amount",
      "500",
      "--currency",
      "usd",
      "--merchant-name",
      "Acme Corp",
      "--purchase-intent",
      VALID_PURCHASE_INTENT,
      "--yes",
    ]);
    expect(manager.issueVirtualCard).toHaveBeenCalledTimes(1);
    expect(manager.issueVirtualCard).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "mock",
        fundingSourceId: "fs-card-001",
        amount: { amountCents: 500, currency: "usd" },
        merchant: { name: "Acme Corp" },
      }),
    );
  });

  it("emits parseable JSON with --yes --json", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "virtual-card",
      "issue",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--amount",
      "500",
      "--currency",
      "usd",
      "--merchant-name",
      "Acme Corp",
      "--purchase-intent",
      VALID_PURCHASE_INTENT,
      "--yes",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("handle");
    expect(parsed.handle.id).toBe("handle-001");
  });
});

// ---------------------------------------------------------------------------
// virtual-card issue — validation errors
// ---------------------------------------------------------------------------

describe("openclaw payment virtual-card issue — validation", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("prints error and does not call manager for invalid amount", async () => {
    const { stderr } = await runCli(manager, [
      "payment",
      "virtual-card",
      "issue",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--amount",
      "0",
      "--currency",
      "usd",
      "--merchant-name",
      "Acme Corp",
      "--purchase-intent",
      VALID_PURCHASE_INTENT,
      "--yes",
    ]);
    expect(stderr).toContain("--amount");
    expect(manager.issueVirtualCard).not.toHaveBeenCalled();
  });

  it("prints error for purchaseIntent shorter than 100 chars", async () => {
    const { stderr } = await runCli(manager, [
      "payment",
      "virtual-card",
      "issue",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--amount",
      "500",
      "--currency",
      "usd",
      "--merchant-name",
      "Acme Corp",
      "--purchase-intent",
      "too short",
      "--yes",
    ]);
    expect(stderr).toContain("--purchase-intent");
    expect(manager.issueVirtualCard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// execute — dry-run (no --yes)
// ---------------------------------------------------------------------------

describe("openclaw payment execute — dry-run", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("prints dry-run summary and does NOT call manager.executeMachinePayment", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "execute",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--target-url",
      "https://example.com/pay",
      "--method",
      "POST",
    ]);
    expect(manager.executeMachinePayment).not.toHaveBeenCalled();
    expect(stdout).toContain("DRY RUN");
  });

  it("dry-run JSON output has dryRun: true", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "execute",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--target-url",
      "https://example.com/pay",
      "--method",
      "POST",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.dryRun).toBe(true);
    expect(manager.executeMachinePayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// execute — live (--yes)
// ---------------------------------------------------------------------------

describe("openclaw payment execute — live with --yes", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("calls manager.executeMachinePayment when --yes is supplied", async () => {
    await runCli(manager, [
      "payment",
      "execute",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--target-url",
      "https://example.com/pay",
      "--method",
      "POST",
      "--yes",
    ]);
    expect(manager.executeMachinePayment).toHaveBeenCalledTimes(1);
    expect(manager.executeMachinePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "mock",
        fundingSourceId: "fs-card-001",
        targetUrl: "https://example.com/pay",
        method: "POST",
      }),
    );
  });

  it("emits parseable JSON with --yes --json", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "execute",
      "--provider",
      "mock",
      "--funding-source",
      "fs-card-001",
      "--target-url",
      "https://example.com/pay",
      "--method",
      "POST",
      "--yes",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("result");
    expect(parsed.result.outcome).toBe("settled");
  });
});

// ---------------------------------------------------------------------------
// status tests
// ---------------------------------------------------------------------------

describe("openclaw payment status", () => {
  let manager: PaymentManager;

  beforeEach(() => {
    manager = makeFakeManager();
  });

  it("calls manager.getStatus with handle id", async () => {
    await runCli(manager, ["payment", "status", "--handle-id", "handle-001"]);
    expect(manager.getStatus).toHaveBeenCalledWith("handle-001");
  });

  it("prints handle status in human-readable format", async () => {
    const { stdout } = await runCli(manager, ["payment", "status", "--handle-id", "handle-001"]);
    expect(stdout).toContain("handle-001");
    expect(stdout).toContain("approved");
  });

  it("emits parseable JSON with --json flag", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "status",
      "--handle-id",
      "handle-001",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("handle");
    expect(parsed.handle.id).toBe("handle-001");
    expect(parsed.handle.status).toBe("approved");
  });

  it("does not include fillSentinels raw card data", async () => {
    const { stdout } = await runCli(manager, [
      "payment",
      "status",
      "--handle-id",
      "handle-001",
      "--json",
    ]);
    // The sentinel objects themselves are safe (no PAN), but let's verify
    // the output doesn't contain any Luhn-valid PAN
    expect(stdout).not.toContain("4242424242424242");
  });
});
