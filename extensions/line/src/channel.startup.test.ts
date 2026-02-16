import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

function createRuntime() {
  const probeLineBot = vi.fn(async () => ({ ok: false }));
  const monitorLineProvider = vi.fn(async () => ({
    account: { accountId: "default" },
    handleWebhook: async () => {},
    stop: () => {},
  }));

  const runtime = {
    channel: {
      line: {
        probeLineBot,
        monitorLineProvider,
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  return { runtime, probeLineBot, monitorLineProvider };
}

function createStartAccountCtx(params: {
  token: string;
  secret: string;
  runtime: unknown;
}) {
  return {
    account: {
      accountId: "default",
      channelAccessToken: params.token,
      channelSecret: params.secret,
      config: {},
    },
    cfg: {} as OpenClawConfig,
    runtime: params.runtime,
    abortSignal: undefined,
    log: { info: vi.fn(), debug: vi.fn() },
  };
}

describe("linePlugin gateway.startAccount", () => {
  it("fails startup when channel secret is missing", async () => {
    const { runtime, monitorLineProvider } = createRuntime();
    setLineRuntime(runtime);

    await expect(
      linePlugin.gateway.startAccount(
        createStartAccountCtx({
          token: "token",
          secret: "   ",
          runtime: {},
        }) as never,
      ),
    ).rejects.toThrow('LINE webhook mode requires a non-empty channel secret for account "default".');
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("fails startup when channel access token is missing", async () => {
    const { runtime, monitorLineProvider } = createRuntime();
    setLineRuntime(runtime);

    await expect(
      linePlugin.gateway.startAccount(
        createStartAccountCtx({
          token: "   ",
          secret: "secret",
          runtime: {},
        }) as never,
      ),
    ).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel access token for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("starts provider when token and secret are present", async () => {
    const { runtime, monitorLineProvider } = createRuntime();
    setLineRuntime(runtime);

    await linePlugin.gateway.startAccount(
      createStartAccountCtx({
        token: "token",
        secret: "secret",
        runtime: {},
      }) as never,
    );

    expect(monitorLineProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        channelAccessToken: "token",
        channelSecret: "secret",
        accountId: "default",
      }),
    );
  });
});
