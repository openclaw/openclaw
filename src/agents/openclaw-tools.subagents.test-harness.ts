import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

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
