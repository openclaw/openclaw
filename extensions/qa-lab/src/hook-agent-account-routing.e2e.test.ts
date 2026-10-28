import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const HOOK_TOKEN = "qa-hook-account-routing-token";
const MARKER = "QA_HOOK_ACCOUNT_ROUTING_OK";
const DEFAULT_MARKER = "QA_HOOK_DEFAULT_ACCOUNT_ROUTING_OK";
const MODEL = "mock-openai/gpt-5.6-luna";

const cleanups: Array<() => Promise<void>> = [];

async function startHookAccountFixture() {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const lab = await startQaLabServer({ repoRoot, embeddedGateway: "disabled" });
  cleanups.push(() => lab.stop());
  const mock = await startQaProviderServer("mock-openai", { modelRefs: [MODEL] });
  if (!mock) {
    throw new Error("mock-openai provider server did not start");
  }
  cleanups.push(() => mock.stop());
  const gatewayOwner = createQaGatewayChild();
  cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
  const transport = createQaChannelTransport(lab.state);
  const gateway = await gatewayOwner.start({
    repoRoot,
    useRepoCli: true,
    initializeCurrentRuntimeState: true,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    providerMode: "mock-openai",
    primaryModel: MODEL,
    alternateModel: MODEL,
    transportBaseUrl: lab.listenUrl,
    transport,
    controlUiEnabled: false,
    mutateConfig: (config) => {
      const qaChannel = config.channels?.["qa-channel"];
      if (!qaChannel) {
        throw new Error("qa-channel transport config missing");
      }
      config.hooks = { enabled: true, token: HOOK_TOKEN, path: "/hooks" };
      Object.assign(qaChannel, {
        defaultAccount: "default",
        accounts: {
          default: { name: "Default" },
          work: { name: "Work" },
          disabled: { name: "Disabled", enabled: false },
        },
      });
      return config;
    },
  });
  return {
    lab,
    outbound: () =>
      lab.state.getSnapshot().messages.filter((message) => message.direction === "outbound"),
    post: async (overrides: { accountId?: string; message?: string; to?: string } = {}) => {
      const response = await fetch(`${gateway.baseUrl}/hooks/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOK_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          message: `Reply exactly: ${MARKER}`,
          deliver: true,
          channel: "qa-channel",
          to: "dm:hook-recipient",
          ...overrides,
        }),
      });
      return { status: response.status, json: (await response.json()) as unknown };
    },
  };
}

describe("hook agent account routing product proof", () => {
  let fixture: Awaited<ReturnType<typeof startHookAccountFixture>>;
  const waitOutbound = (count: number, accountId: string, id: string, text: string) =>
    vi.waitFor(
      () => {
        const outbound = fixture.outbound();
        expect(outbound).toHaveLength(count);
        expect(outbound.at(-1)).toMatchObject({
          accountId,
          conversation: { id, kind: "direct" },
          text,
        });
      },
      { interval: 50, timeout: 60_000 },
    );

  beforeAll(async () => {
    fixture = await startHookAccountFixture();
  }, 180_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup().catch((error: unknown) => errors.push(error));
    }
    if (errors.length) {
      throw new AggregateError(errors, "hook account routing fixture cleanup failed");
    }
  });

  it(
    "rejects invalid explicit accounts before running the agent",
    { timeout: 180_000 },
    async () => {
      const messageCountBefore = fixture.lab.state.getSnapshot().messages.length;

      for (const { accountId, expectedError } of [
        { accountId: "missing", expectedError: 'Unknown account "missing"' },
        { accountId: "disabled", expectedError: 'Account "disabled"' },
        { accountId: "__proto__", expectedError: 'Invalid account ID "__proto__"' },
      ]) {
        const response = await fixture.post({ accountId });

        expect(response.status, JSON.stringify(response.json)).toBe(400);
        expect(response.json).toMatchObject({
          ok: false,
          runId: expect.any(String),
          error: expect.stringContaining(expectedError),
        });
      }
      expect(fixture.lab.state.getSnapshot().messages).toHaveLength(messageCountBefore);
    },
  );

  it(
    "delivers exactly once through the selected qa-channel account",
    { timeout: 180_000 },
    async () => {
      const outboundCountBefore = fixture.outbound().length;
      const response = await fixture.post({ accountId: "work" });
      expect(response.status, JSON.stringify(response.json)).toBe(200);

      expect(response.json).toMatchObject({ ok: true, runId: expect.any(String) });

      await waitOutbound(outboundCountBefore + 1, "work", "hook-recipient", MARKER);
      await sleep(500);

      const outbound = fixture.outbound();
      expect(outbound).toHaveLength(outboundCountBefore + 1);
      expect(
        outbound.slice(outboundCountBefore).filter((message) => message.accountId === "default"),
      ).toHaveLength(0);

      const defaultResponse = await fixture.post({
        message: `Reply exactly: ${DEFAULT_MARKER}`,
        to: "dm:hook-default-recipient",
      });
      expect(defaultResponse.status, JSON.stringify(defaultResponse.json)).toBe(200);

      await waitOutbound(
        outboundCountBefore + 2,
        "default",
        "hook-default-recipient",
        DEFAULT_MARKER,
      );
    },
  );
});
