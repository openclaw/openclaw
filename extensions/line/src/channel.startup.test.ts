import type {
  ChannelGatewayContext,
  ChannelAccountSnapshot,
  OpenClawConfig,
  PluginRuntime,
  ResolvedLineAccount,
} from "openclaw/plugin-sdk/line";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
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
  runtime: ReturnType<typeof createRuntimeEnv>;
  abortSignal?: AbortSignal;
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
    abortSignal: params.abortSignal ?? new AbortController().signal,
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

    const abort = new AbortController();
    const task = linePlugin.gateway!.startAccount!(
      createStartAccountCtx({
        token: "token",
        secret: "secret",
        runtime: createRuntimeEnv(),
        abortSignal: abort.signal,
      }),
    );

    await vi.waitFor(() => {
      expect(monitorLineProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          channelAccessToken: "token",
          channelSecret: "secret",
          accountId: "default",
        }),
      );
    });

    abort.abort();
    await task;
  });
});

describe("linePlugin status", () => {
  it("does not report missing token or secret when snapshot came from file-backed config", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "token-from-file",
        channelSecret: "secret-from-file",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(true);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([]);
  });

  it("keeps per-field warnings when only one credential is missing", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "   ",
        channelSecret: "secret-from-file",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel access token not configured",
      },
    ]);
  });

  it("keeps per-field warnings when only the channel secret is missing", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "token-from-file",
        channelSecret: "   ",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel secret not configured",
      },
    ]);
  });

  it("reports both warnings when both file-backed credentials are missing", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "   ",
        channelSecret: "   ",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel access token not configured",
      },
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel secret not configured",
      },
    ]);
  });
});
