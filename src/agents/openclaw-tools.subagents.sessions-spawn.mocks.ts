import { vi } from "vitest";

// Avoid exporting inferred vitest mock types (TS2742 under pnpm + d.ts emit).
export type CallGatewayMock = ((opts: unknown) => unknown) & ReturnType<typeof vi.fn>;
export const callGatewayMock: CallGatewayMock = vi.fn() as unknown as CallGatewayMock;
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
