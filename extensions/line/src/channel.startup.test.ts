import type {
  ChannelGatewayContext,
  ChannelAccountSnapshot,
  OpenClawConfig,
  PluginRuntime,
  ResolvedLineAccount,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
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

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}

function createStartAccountCtx(params: {
  token: string;
  secret: string;
  runtime: RuntimeEnv;
}): ChannelGatewayContext<ResolvedLineAccount> {
  const snapshot: ChannelAccountSnapshot = {
    accountId: "default",
    configured: true,
    enabled: true,
    running: false,
  };
  return {
    accountId: "default",
    account: {
      accountId: "default",
      enabled: true,
      channelAccessToken: params.token,
      channelSecret: params.secret,
      tokenSource: "config" as const,
      config: {} as ResolvedLineAccount["config"],
    },
    cfg: {} as OpenClawConfig,
    runtime: params.runtime,
    abortSignal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: vi.fn(),
  };
}

describe("linePlugin gateway.startAccount", () => {
  it("fails startup when channel secret is missing", async () => {
    const { runtime, monitorLineProvider } = createRuntime();
    setLineRuntime(runtime);

    await expect(
      linePlugin.gateway!.startAccount!(
        createStartAccountCtx({
          token: "token",
          secret: "   ",
          runtime: createRuntimeEnv(),
        }),
      ),
    ).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel secret for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("fails startup when channel access token is missing", async () => {
    const { runtime, monitorLineProvider } = createRuntime();
    setLineRuntime(runtime);

    await expect(
      linePlugin.gateway!.startAccount!(
        createStartAccountCtx({
          token: "   ",
          secret: "secret",
          runtime: createRuntimeEnv(),
        }),
      ),
    ).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel access token for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("starts provider when token and secret are present", async () => {
    const { runtime, monitorLineProvider } = createRuntime();
    setLineRuntime(runtime);

    await linePlugin.gateway!.startAccount!(
      createStartAccountCtx({
        token: "token",
        secret: "secret",
        runtime: createRuntimeEnv(),
      }),
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
