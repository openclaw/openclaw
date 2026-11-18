import fs from "node:fs/promises";
import path from "node:path";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createEmptyPluginRegistry,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import type { ResolvedZaloAccount } from "../types.js";

type MonitorModule = typeof import("../monitor.js");

const monitorModuleUrl = new URL("../monitor.ts", import.meta.url).href;
const webhookModuleUrl = new URL("../monitor.webhook.ts", import.meta.url).href;
const apiModuleId = new URL("../api.js", import.meta.url).pathname;
const runtimeModuleId = new URL("../runtime.js", import.meta.url).pathname;

type UnknownCall = (...args: unknown[]) => unknown;
type AsyncUnknownCall = (...args: unknown[]) => Promise<unknown>;
const cachedMonitorModules = new Map<string, Promise<MonitorModule>>();
let lifecycleStateDir: string | undefined;
let previousLifecycleStateDir: string | undefined;
let waitForLifecycleIngressIdle: (() => Promise<void>) | undefined;

const apiMocks = vi.hoisted(() => ({
  setWebhook: vi.fn<AsyncUnknownCall>(async () => ({ ok: true, result: { url: "" } })),
  deleteWebhook: vi.fn<AsyncUnknownCall>(async () => ({ ok: true, result: { url: "" } })),
  getWebhookInfo: vi.fn<AsyncUnknownCall>(async () => ({ ok: true, result: { url: "" } })),
  getUpdates: vi.fn<UnknownCall>(() => new Promise(() => {})),
  sendChatAction: vi.fn<AsyncUnknownCall>(async () => ({ ok: true })),
  sendMessage: vi.fn<AsyncUnknownCall>(async () => ({
    ok: true,
    result: { message_id: "zalo-test-reply-1" },
  })),
  sendPhoto: vi.fn<AsyncUnknownCall>(async () => ({ ok: true })),
}));

const getZaloRuntimeMock = vi.hoisted(() => vi.fn<UnknownCall>());
export { getZaloRuntimeMock };
export const {
  getUpdates: getUpdatesMock,
  sendMessage: sendMessageMock,
  sendPhoto: sendPhotoMock,
} = apiMocks;

function installLifecycleModuleMocks() {
  vi.doMock("openclaw/plugin-sdk/channel-outbound", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-outbound")>(
      "openclaw/plugin-sdk/channel-outbound",
    );
    return {
      ...actual,
      createChannelIngressMonitor: (
        ...args: Parameters<typeof actual.createChannelIngressMonitor>
      ) => {
        const monitor = actual.createChannelIngressMonitor(...args);
        waitForLifecycleIngressIdle = monitor.waitForIdle;
        return monitor;
      },
    };
  });
  vi.doMock(apiModuleId, async () => {
    return { ...(await vi.importActual<object>(apiModuleId)), ...apiMocks };
  });

  vi.doMock(runtimeModuleId, () => ({
    getZaloRuntime: getZaloRuntimeMock,
  }));
}

const importCachedWebhookModule = createLazyRuntimeModule(
  () => import(webhookModuleUrl) as Promise<typeof import("../monitor.webhook.js")>,
);

export async function resetLifecycleTestState() {
  waitForLifecycleIngressIdle = undefined;
  // Close agents first: releasing their leases needs shared state (Windows handles).
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  if (lifecycleStateDir) {
    await fs.rm(lifecycleStateDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    lifecycleStateDir = undefined;
  }
  if (previousLifecycleStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousLifecycleStateDir;
    previousLifecycleStateDir = undefined;
  }
  vi.clearAllMocks();
  (await importCachedWebhookModule()).zaloWebhookRuntime.clearZaloWebhookSecurityStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
}

export function setLifecycleRuntimeCore(
  channel: NonNullable<NonNullable<Parameters<typeof createPluginRuntimeMock>[0]>["channel"]>,
  state?: NonNullable<Parameters<typeof createPluginRuntimeMock>[0]>["state"],
) {
  getZaloRuntimeMock.mockReturnValue(createPluginRuntimeMock({ channel, state }));
}

export async function loadCachedLifecycleMonitorModule(key: string): Promise<MonitorModule> {
  if (!cachedMonitorModules.has(key)) {
    installLifecycleModuleMocks();
    cachedMonitorModules.set(key, import(`${monitorModuleUrl}?t=${key}`) as Promise<MonitorModule>);
  }
  return await cachedMonitorModules.get(key)!;
}

export async function startWebhookLifecycleMonitor(params: {
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  cacheKey: string;
}) {
  const { account, config, cacheKey } = params;
  const core = getZaloRuntimeMock() as PluginRuntime;
  const stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-zalo-lifecycle-")),
  );
  previousLifecycleStateDir = process.env.OPENCLAW_STATE_DIR;
  lifecycleStateDir = stateDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  core.state.openChannelIngressQueue = (<T>(options: { accountId?: string }) =>
    createChannelIngressQueueForTests<T>({
      channelId: "zalo",
      accountId: options.accountId ?? "default",
      stateDir,
    })) as PluginRuntime["state"]["openChannelIngressQueue"];
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const { normalizeSecretInputString } = await import("openclaw/plugin-sdk/secret-input");
  const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(cacheKey);
  const run = monitorZaloProvider({
    token: "zalo-token",
    account,
    config,
    runtime,
    abortSignal: abort.signal,
    useWebhook: true,
    webhookUrl: account.config.webhookUrl,
    webhookSecret: normalizeSecretInputString(account.config.webhookSecret),
  });

  const route = await vi.waitFor(() => {
    const webhookRoute = registry.httpRoutes.find((entry) => entry.source === "zalo-webhook");
    const hostedMediaRoute = registry.httpRoutes.find(
      (entry) => entry.source === "zalo-hosted-media",
    );
    if (apiMocks.setWebhook.mock.calls.length !== 1 || !webhookRoute || !hostedMediaRoute) {
      throw new Error("waiting for webhook registration");
    }
    return webhookRoute;
  });

  if (!waitForLifecycleIngressIdle) {
    throw new Error("missing Zalo webhook ingress monitor");
  }

  return {
    route,
    runtime,
    waitForIdle: waitForLifecycleIngressIdle,
    stop: async () => {
      abort.abort();
      await run;
    },
  };
}
