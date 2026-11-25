import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { setA2aChannelRuntime } from "./runtime.js";
import * as taskStores from "./task-store.js";
import { createTerminalStoreFixture } from "./task-store.test-support.js";
import type { A2aChannelConfig, ResolvedA2aChannelAccount } from "./types.js";

export function createA2aGatewayFixture(
  options: {
    cfg?: OpenClawConfig;
    config?: A2aChannelConfig;
    version?: string;
    terminalStore?: ReturnType<typeof createTerminalStoreFixture>;
  } = {},
) {
  const registry = createTestRegistry([]);
  setActivePluginRegistry(registry);
  const runtime = {
    ...createPluginRuntimeMock(),
    ...(options.version ? { version: options.version } : {}),
  };
  vi.spyOn(taskStores, "openTerminalStore").mockReturnValue(
    options.terminalStore ?? createTerminalStoreFixture(),
  );
  setA2aChannelRuntime(runtime);
  const controller = new AbortController();
  const account: ResolvedA2aChannelAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    config: options.config ?? { peers: { hermes: { token: "test-token" } } },
    unresolvedPeers: [],
    unresolvedOutboundPeers: [],
  };
  const statusPatchSink = vi.fn();
  const ctx = createStartAccountContext({
    account,
    cfg: options.cfg,
    abortSignal: controller.signal,
    statusPatchSink,
  });
  ctx.channelRuntime = runtime.channel;
  return { registry, runtime, controller, account, statusPatchSink, ctx };
}
