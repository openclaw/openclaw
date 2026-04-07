import { vi, type Mock } from "vitest";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "../../../test/helpers/plugins/plugin-registry.js";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "../src/types.js";

type MonitorModule = typeof import("../src/monitor.js");
type SecretInputModule = typeof import("../src/secret-input.js");
type WebhookModule = typeof import("../src/monitor.webhook.js");

const monitorModuleUrl = new URL("../src/monitor.ts", import.meta.url).href;
const secretInputModuleUrl = new URL("../src/secret-input.ts", import.meta.url).href;
const webhookModuleUrl = new URL("../src/monitor.webhook.ts", import.meta.url).href;
const apiModuleId = new URL("../src/api.js", import.meta.url).pathname;
const runtimeModuleId = new URL("../src/runtime.js", import.meta.url).pathname;

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type ZaloLifecycleMocks = {
  setWebhookMock: AsyncUnknownMock;
  deleteWebhookMock: AsyncUnknownMock;
  getWebhookInfoMock: AsyncUnknownMock;
  getUpdatesMock: UnknownMock;
  sendChatActionMock: AsyncUnknownMock;
  sendMessageMock: AsyncUnknownMock;
  sendPhotoMock: AsyncUnknownMock;
  getZaloRuntimeMock: UnknownMock;
};

const pendingGetUpdatesResolves: Array<(value: { ok: true; result: undefined }) => void> = [];

function resolvePendingGetUpdates() {
  const resolves = pendingGetUpdatesResolves.splice(0, pendingGetUpdatesResolves.length);
  for (const resolve of resolves) {
    resolve({ ok: true, result: undefined });
  }
}

function applyLifecycleMockDefaults(mocks: ZaloLifecycleMocks) {
  mocks.setWebhookMock.mockReset().mockResolvedValue({ ok: true, result: { url: "" } });
  mocks.deleteWebhookMock.mockReset().mockResolvedValue({ ok: true, result: { url: "" } });
  mocks.getWebhookInfoMock.mockReset().mockResolvedValue({ ok: true, result: { url: "" } });
  mocks.getUpdatesMock.mockReset().mockImplementation(
    () =>
      new Promise<{ ok: true; result: undefined }>((resolve) => {
        pendingGetUpdatesResolves.push(resolve);
      }),
  );
  mocks.sendChatActionMock.mockReset().mockResolvedValue({ ok: true });
  mocks.sendMessageMock.mockReset().mockResolvedValue({
    ok: true,
    result: { message_id: "zalo-test-reply-1" },
  });
  mocks.sendPhotoMock.mockReset().mockResolvedValue({ ok: true });
  mocks.getZaloRuntimeMock.mockReset();
}

const lifecycleMocks = vi.hoisted((): ZaloLifecycleMocks => {
  const mocks: ZaloLifecycleMocks = {
    setWebhookMock: vi.fn(),
    deleteWebhookMock: vi.fn(),
    getWebhookInfoMock: vi.fn(),
    getUpdatesMock: vi.fn(),
    sendChatActionMock: vi.fn(),
    sendMessageMock: vi.fn(),
    sendPhotoMock: vi.fn(),
    getZaloRuntimeMock: vi.fn(),
  };
  applyLifecycleMockDefaults(mocks);
  return mocks;
});

export const setWebhookMock = lifecycleMocks.setWebhookMock;
export const deleteWebhookMock = lifecycleMocks.deleteWebhookMock;
export const getWebhookInfoMock = lifecycleMocks.getWebhookInfoMock;
export const getUpdatesMock = lifecycleMocks.getUpdatesMock;
export const sendChatActionMock = lifecycleMocks.sendChatActionMock;
export const sendMessageMock = lifecycleMocks.sendMessageMock;
export const sendPhotoMock = lifecycleMocks.sendPhotoMock;
export const getZaloRuntimeMock: UnknownMock = lifecycleMocks.getZaloRuntimeMock;
export { resolvePendingGetUpdates };

function installLifecycleModuleMocks() {
  vi.doMock(apiModuleId, async () => {
    const actual = await vi.importActual<object>(apiModuleId);
    return {
      ...actual,
      deleteWebhook: lifecycleMocks.deleteWebhookMock,
      getUpdates: lifecycleMocks.getUpdatesMock,
      getWebhookInfo: lifecycleMocks.getWebhookInfoMock,
      sendChatAction: lifecycleMocks.sendChatActionMock,
      sendMessage: lifecycleMocks.sendMessageMock,
      sendPhoto: lifecycleMocks.sendPhotoMock,
      setWebhook: lifecycleMocks.setWebhookMock,
    };
  });

  vi.doMock(runtimeModuleId, () => ({
    getZaloRuntime: lifecycleMocks.getZaloRuntimeMock,
  }));
}

async function importMonitorModule(params: {
  cacheBust: string;
  mocked: boolean;
}): Promise<MonitorModule> {
  vi.resetModules();
  if (params.mocked) {
    installLifecycleModuleMocks();
  } else {
    vi.doUnmock(apiModuleId);
    vi.doUnmock(runtimeModuleId);
  }
  return (await import(`${monitorModuleUrl}?t=${params.cacheBust}-${Date.now()}`)) as MonitorModule;
}

async function importSecretInputModule(cacheBust: string): Promise<SecretInputModule> {
  return (await import(
    `${secretInputModuleUrl}?t=${cacheBust}-${Date.now()}`
  )) as SecretInputModule;
}

async function importWebhookModule(cacheBust: string): Promise<WebhookModule> {
  return (await import(`${webhookModuleUrl}?t=${cacheBust}-${Date.now()}`)) as WebhookModule;
}

export async function resetLifecycleTestState() {
  vi.clearAllMocks();
  resolvePendingGetUpdates();
  applyLifecycleMockDefaults(lifecycleMocks);
  const { clearZaloWebhookSecurityStateForTest } = await importWebhookModule("reset-webhook");
  clearZaloWebhookSecurityStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
}

export function setLifecycleRuntimeCore(
  channel: NonNullable<NonNullable<Parameters<typeof createPluginRuntimeMock>[0]>["channel"]>,
) {
  getZaloRuntimeMock.mockReturnValue(
    createPluginRuntimeMock({
      channel,
    }),
  );
}

export async function loadLifecycleMonitorModule(): Promise<MonitorModule> {
  return await importMonitorModule({ cacheBust: "monitor", mocked: true });
}

export async function startWebhookLifecycleMonitor(params: {
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  token?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}) {
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const accountWebhookUrl =
    typeof params.account.config?.webhookUrl === "string"
      ? params.account.config.webhookUrl
      : undefined;
  const webhookUrl = params.webhookUrl ?? accountWebhookUrl;
  const { normalizeSecretInputString } = await importSecretInputModule("secret-input");
  const webhookSecret =
    params.webhookSecret ?? normalizeSecretInputString(params.account.config?.webhookSecret);
  const { monitorZaloProvider } = await loadLifecycleMonitorModule();
  const run = monitorZaloProvider({
    token: params.token ?? "zalo-token",
    account: params.account,
    config: params.config,
    runtime,
    abortSignal: abort.signal,
    useWebhook: true,
    webhookUrl,
    webhookSecret,
  });

  await vi.waitFor(() => {
    if (setWebhookMock.mock.calls.length !== 1 || registry.httpRoutes.length !== 1) {
      throw new Error("waiting for webhook registration");
    }
  });

  const route = registry.httpRoutes[0];
  if (!route) {
    throw new Error("missing plugin HTTP route");
  }

  return {
    abort,
    registry,
    route,
    run,
    runtime,
    stop: async () => {
      abort.abort();
      await run;
    },
  };
}
