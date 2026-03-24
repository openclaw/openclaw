import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./tool.js";

describe("pythia-oracle helpers", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
    tempDirs.length = 0;
  });

  it("builds a stable grant key from payment requirements", () => {
    expect(
      __testing.buildGrantKey({
        scheme: "exact",
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xABC",
        maxTimeoutSeconds: 300,
        extra: {},
      }),
    ).toBe("eip155:8453|usdc|0xabc");
  });

  it("formats an approval prompt with the command reply hint", () => {
    const text = __testing.buildApprovalPrompt({
      id: "approval-1",
      config: {
        url: "https://pythia-mcp.fly.dev/",
        serviceName: "Pythia Oracle",
        walletPrivateKeyEnvVar: "PYTHIA_BASE_PRIVATE_KEY",
        defaultAgentId: "projectmanager",
        expectedPriceUsd: 0.025,
        approvalTimeoutMs: 120_000,
        allowAlwaysCache: true,
      },
      req: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xabc",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      agentId: "projectmanager",
      expiresAtMs: Date.now() + 60_000,
    });

    expect(text).toContain("Service: Pythia Oracle");
    expect(text).toContain("ID: approval-1");
    expect(text).toContain("Price: 0.025 USDC on eip155:8453");
    expect(text).toContain("/approve <id> allow-once|allow-always|deny");
  });

  it("normalizes x402 atomic amounts into human-readable USDC", () => {
    expect(
      __testing.formatHumanPaymentAmount({
        req: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "25000",
          payTo: "0xabc",
          maxTimeoutSeconds: 300,
          extra: {},
        },
      }),
    ).toBe("0.025 USDC");
  });

  it("describes payment requirements with normalized amounts", () => {
    expect(
      __testing.describePaymentRequirement({
        req: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "USDC",
          amount: "25000",
          payTo: "0xabc",
          maxTimeoutSeconds: 300,
          extra: {},
        },
      }),
    ).toBe("0.025 USDC on eip155:8453");
  });

  it("records paid responses into the per-agent payment state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pythia-oracle-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "payments.json");

    await __testing.maybeRecordPaidResponse({
      statePath,
      req: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xabc",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      expectedPriceUsd: 0.025,
      response: new Response(JSON.stringify({ ok: true }), {
        headers: {
          "PAYMENT-RESPONSE": "eyJ4NDAyVmVyc2lvbiI6MiwidHJhbnNhY3Rpb24iOiIweHR4aGFzaCJ9",
        },
      }),
    });

    const state = await __testing.loadPaymentState(statePath);
    const dayKey = new Date().toISOString().slice(0, 10);
    expect(state.dailySpendUsd?.[dayKey]).toBeCloseTo(0.025, 6);
    expect(state.history?.[0]?.transaction).toBe("0xtxhash");
  });

  it("extracts MCP payment settlement metadata from tool results", () => {
    expect(
      __testing.extractPaymentResponseFromToolResult({
        result: {
          _meta: {
            "x402/payment-response": {
              success: true,
              transaction: "0xmeta",
            },
          },
        },
      }),
    ).toEqual({
      success: true,
      transaction: "0xmeta",
    });
  });

  it("records MCP payment settlements from tool-result metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pythia-oracle-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "payments.json");

    await __testing.maybeRecordPaidResponse({
      statePath,
      req: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xabc",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      expectedPriceUsd: 0.025,
      toolResult: {
        result: {
          _meta: {
            "x402/payment-response": {
              success: true,
              transaction: "0xmeta",
            },
          },
        },
      },
    });

    const state = await __testing.loadPaymentState(statePath);
    const dayKey = new Date().toISOString().slice(0, 10);
    expect(state.dailySpendUsd?.[dayKey]).toBeCloseTo(0.025, 6);
    expect(state.history?.[0]?.transaction).toBe("0xmeta");
  });

  it("records successful paid retries even without settlement metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pythia-oracle-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "payments.json");

    await __testing.maybeRecordPaidResponse({
      statePath,
      req: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xabc",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      expectedPriceUsd: 0.025,
      toolResult: {
        result: {
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
      },
      forceRecord: true,
    });

    const state = await __testing.loadPaymentState(statePath);
    const dayKey = new Date().toISOString().slice(0, 10);
    expect(state.dailySpendUsd?.[dayKey]).toBeCloseTo(0.025, 6);
    expect(state.history?.[0]?.transaction).toBeUndefined();
  });

  it("extracts structured oracle payloads from MCP responses", () => {
    expect(
      __testing.extractOraclePayload({
        result: {
          structuredContent: { response: "You are optimizing the wrong thing." },
        },
      }),
    ).toEqual({ response: "You are optimizing the wrong thing." });
  });

  it("detects x402 payment challenges embedded in MCP tool errors", () => {
    const response = {
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              x402Version: 2,
              accepts: [
                {
                  scheme: "exact",
                  network: "eip155:8453",
                  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                  amount: "25000",
                  payTo: "0xabc",
                },
              ],
              error: "Payment required",
            }),
          },
        ],
      },
    };

    expect(__testing.parseX402PaymentRequired(__testing.extractToolErrorText(response))).toEqual({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "25000",
          payTo: "0xabc",
          maxTimeoutSeconds: 300,
          extra: {},
        },
      ],
      error: "Payment required",
      resource: {
        url: "mcp://tool/consult_oracle",
      },
    });
  });

  it("parses MCP event-stream responses", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message\r\ndata: {"jsonrpc":"2.0","id":"call-1","result":{"structuredContent":{"response":"de',
            ),
          );
          controller.enqueue(encoder.encode('coded"}}}\r\n\r\n'));
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
        },
      },
    );

    await expect(__testing.readMcpJsonResponse(response)).resolves.toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        structuredContent: {
          response: "decoded",
        },
      },
    });
  });
});
