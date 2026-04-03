import { vi } from "vitest";
import { __testing as queueCleanupTesting } from "../auto-reply/reply/queue/cleanup.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { __testing as subagentAnnounceTesting } from "./subagent-announce.js";
import { __testing as subagentControlTesting } from "./subagent-control.js";

export type LoadedConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;

export const callGatewayMock: MockFn = vi.fn();

const defaultConfig: LoadedConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

let configOverride: LoadedConfig = defaultConfig;

export function setSubagentsConfigOverride(next: LoadedConfig) {
  configOverride = next;
}

export function resetSubagentsConfigOverride() {
  configOverride = defaultConfig;
}

function applySharedSubagentTestDeps() {
  subagentControlTesting.setDepsForTest({
    callGateway: (optsUnknown) => callGatewayMock(optsUnknown),
  });
  subagentAnnounceTesting.setDepsForTest({
    callGateway: (optsUnknown) => callGatewayMock(optsUnknown),
    loadConfig: () => configOverride,
  });
  queueCleanupTesting.setDepsForTests({
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  });
}

applySharedSubagentTestDeps();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});
