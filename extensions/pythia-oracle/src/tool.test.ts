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
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xABC",
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
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xabc",
      },
      agentId: "projectmanager",
      expiresAtMs: Date.now() + 60_000,
    });

    expect(text).toContain("Service: Pythia Oracle");
    expect(text).toContain("ID: approval-1");
    expect(text).toContain("/approve <id> allow-once|allow-always|deny");
  });

  it("records paid responses into the per-agent payment state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pythia-oracle-"));
    tempDirs.push(dir);
    const statePath = path.join(dir, "payments.json");

    await __testing.maybeRecordPaidResponse({
      statePath,
      req: {
        network: "eip155:8453",
        asset: "USDC",
        amount: "25000",
        payTo: "0xabc",
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

  it("extracts structured oracle payloads from MCP responses", () => {
    expect(
      __testing.extractOraclePayload({
        result: {
          structuredContent: { response: "You are optimizing the wrong thing." },
        },
      }),
    ).toEqual({ response: "You are optimizing the wrong thing." });
  });

  it("parses MCP event-stream responses", async () => {
    const response = new Response(
      'event: message\r\ndata: {"jsonrpc":"2.0","id":"call-1","result":{"structuredContent":{"response":"decoded"}}}\r\n\r\n',
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
