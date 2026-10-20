import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lineAccount } from "./channel-account.test-support.js";
import { lineGatewayAdapter } from "./gateway.js";
import { setLineRuntime } from "./runtime.js";
import type { LineProbeResult } from "./types.js";

const { probeLineBotMock, monitorLineProviderMock } = vi.hoisted(() => ({
  probeLineBotMock: vi.fn(),
  monitorLineProviderMock: vi.fn(async () => ({ stop: async () => {} })),
}));

vi.mock("./probe.runtime.js", () => ({ probeLineBot: probeLineBotMock }));
vi.mock("./monitor.runtime.js", () => ({ monitorLineProvider: monitorLineProviderMock }));

async function startWithProbe(probe: LineProbeResult, account = lineAccount()) {
  probeLineBotMock.mockResolvedValue(probe);
  const warn = vi.fn<(msg: string) => void>();
  await lineGatewayAdapter.startAccount?.({
    ...createStartAccountContext({ account }),
    log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
  });
  return warn;
}

describe("lineGatewayAdapter.startAccount", () => {
  beforeEach(() => {
    probeLineBotMock.mockReset();
    monitorLineProviderMock.mockClear();
    setLineRuntime(createPluginRuntimeMock());
  });

  afterAll(() => {
    vi.doUnmock("./probe.runtime.js");
    vi.doUnmock("./monitor.runtime.js");
    vi.resetModules();
  });

  it.each([
    ["disabled", "webhook URL is registered but switched off"],
    ["unset", "no webhook URL registered"],
  ] as const)("warns at startup when the webhook is %s", async (status, expected) => {
    const warn = await startWithProbe({ ok: true, webhook: { status } });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(expected);
    expect(warn.mock.calls[0]?.[0]).toContain("LINE Developers Console");
  });

  it.each([
    { ok: true, webhook: { status: "active" } },
    { ok: true },
    { ok: false, error: "timeout" },
  ] satisfies LineProbeResult[])("starts without a webhook warning for %j", async (probe) => {
    const warn = await startWithProbe(probe);

    expect(warn).not.toHaveBeenCalled();
    expect(monitorLineProviderMock).toHaveBeenCalledTimes(1);
  });

  // Gateway logs must not expose an operator's opaque route.
  it("keeps an opaque configured route out of the startup warning", async () => {
    const warn = await startWithProbe(
      { ok: true, webhook: { status: "unset" } },
      lineAccount({ webhookPath: "/hooks/line-primary" }),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain("/hooks/line-primary");
    expect(warn.mock.calls[0]?.[0]).toContain("channels.line.webhookPath");
  });
});
