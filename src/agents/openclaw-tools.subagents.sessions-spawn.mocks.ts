import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export const callGatewayMock: MockFn<(opts: unknown) => unknown> = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

export type SessionsSpawnTestConfig = ReturnType<
  (typeof import("../config/config.js"))["loadConfig"]
>;

const defaultConfigOverride: SessionsSpawnTestConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

let configOverride: SessionsSpawnTestConfig = defaultConfigOverride;

export function resetConfigOverride() {
  configOverride = defaultConfigOverride;
}

export function setConfigOverride(next: SessionsSpawnTestConfig) {
  configOverride = next;
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});
