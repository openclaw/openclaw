import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import { createStartAccountContext } from "../../../test/helpers/extensions/start-account-context.js";
import type { OpenClawConfig, PluginRuntime, ResolvedLineAccount } from "../api.js";
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

function createAccount(params: { token: string; secret: string }): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    channelAccessToken: params.token,
    channelSecret: params.secret,
    tokenSource: "config",
    config: {} as ResolvedLineAccount["config"],
  };
}

describe("linePlugin gateway.startAccount", () => {
  it("fails startup when channel secret is missing", async () => {
    const { runtime, monitorLineProvider } = createRuntime();
    setLineRuntime(runtime);

    await expect(
      linePlugin.gateway!.startAccount!(
        createStartAccountContext({
          account: createAccount({ token: "token", secret: "   " }),
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
        createStartAccountContext({
          account: createAccount({ token: "   ", secret: "secret" }),
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
      createStartAccountContext({
        account: createAccount({ token: "token", secret: "secret" }),
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
