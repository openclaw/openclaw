// Line tests cover gateway startup plugin behavior.
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lineGatewayAdapter } from "./gateway.js";
import { setLineRuntime } from "./runtime.js";
import type { LineProbeResult, ResolvedLineAccount } from "./types.js";

const { probeLineBotMock, monitorLineProviderMock, rememberLineBotUserIdMock } = vi.hoisted(() => ({
  probeLineBotMock: vi.fn(),
  monitorLineProviderMock: vi.fn(async () => ({ stop: async () => {} })),
  rememberLineBotUserIdMock: vi.fn(),
}));

vi.mock("./probe.runtime.js", () => ({ probeLineBot: probeLineBotMock }));
vi.mock("./monitor.runtime.js", () => ({ monitorLineProvider: monitorLineProviderMock }));
vi.mock("./outbound-message-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./outbound-message-log.js")>()),
  rememberLineBotUserId: rememberLineBotUserIdMock,
}));

function lineAccount(config: ResolvedLineAccount["config"] = {}): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    config,
  };
}

// The helper types `log` as the plain sink, so the test owns the sink it asserts on.
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
    rememberLineBotUserIdMock.mockClear();
    setLineRuntime(createPluginRuntimeMock());
  });

  afterAll(() => {
    vi.doUnmock("./probe.runtime.js");
    vi.doUnmock("./monitor.runtime.js");
    vi.doUnmock("./outbound-message-log.js");
    vi.resetModules();
  });

  // Reaching this through status costs the operator a flag they have no reason to
  // try when nothing looks wrong, so startup has to say it where they are watching.
  it.each([
    {
      name: "registered but switched off",
      webhook: { status: "disabled" },
      expected: "webhook URL is registered but switched off",
    },
    {
      name: "never registered",
      webhook: { status: "unset" },
      expected: "no webhook URL registered",
    },
  ] as const)("warns at startup when the webhook is $name", async ({ webhook, expected }) => {
    const warn = await startWithProbe({ ok: true, webhook });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(expected);
    expect(warn.mock.calls[0]?.[0]).toContain("LINE Developers Console");
  });

  it.each([
    {
      name: "the webhook is on",
      probe: {
        ok: true,
        webhook: { status: "active" },
      },
    },
    { name: "the probe reported no webhook state", probe: { ok: true } },
    { name: "the probe failed", probe: { ok: false, error: "timeout" } },
  ] satisfies { name: string; probe: LineProbeResult }[])(
    "starts without a webhook warning when $name",
    async ({ probe }) => {
      const warn = await startWithProbe(probe);

      expect(warn).not.toHaveBeenCalled();
      expect(monitorLineProviderMock).toHaveBeenCalledTimes(1);
    },
  );

  // The startup warning reaches gateway logs, which are read far more widely than
  // authenticated status. An operator using an unguessable route as a weak secret
  // must not find it there; the remedy names the config key instead.
  it("keeps an opaque configured route out of the startup warning", async () => {
    const warn = await startWithProbe(
      { ok: true, webhook: { status: "unset" } },
      lineAccount({ webhookPath: "/hooks/line-primary" }),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain("/hooks/line-primary");
    expect(warn.mock.calls[0]?.[0]).toContain("channels.line.webhookPath");
  });

  // Sent ids persist under the bot's own user id, so a re-pointed account never
  // inherits the previous bot's record, and an unknown bot stays memory-only.
  it.each([
    {
      name: "the probe reports the bot",
      probe: { ok: true, bot: { userId: "U-bot" } },
      last: "U-bot",
    },
    { name: "the probe failed", probe: { ok: false, error: "timeout" }, last: undefined },
  ] satisfies { name: string; probe: LineProbeResult; last: string | undefined }[])(
    "records the bot user id for sent messages when $name",
    async ({ probe, last }) => {
      await startWithProbe(probe);

      expect(rememberLineBotUserIdMock.mock.calls).toEqual([["default", last]]);
    },
  );
});
