import { vi } from "vitest";

type SessionsSpawnTestConfig = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;
type CreateOpenClawTools = (typeof import("./openclaw-tools.js"))["createOpenClawTools"];
export type CreateOpenClawToolsOpts = Parameters<CreateOpenClawTools>[0];

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMock = any;

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const defaultConfigOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  } as SessionsSpawnTestConfig;
  const state = { configOverride: defaultConfigOverride };
  return { callGatewayMock, defaultConfigOverride, state };
});

export function getCallGatewayMock(): AnyMock {
  return hoisted.callGatewayMock;
}

export function resetSessionsSpawnConfigOverride(): void {
  hoisted.state.configOverride = hoisted.defaultConfigOverride;
}

export function setSessionsSpawnConfigOverride(next: SessionsSpawnTestConfig): void {
  hoisted.state.configOverride = next;
}

export async function getSessionsSpawnTool(opts: CreateOpenClawToolsOpts) {
  // Dynamic import: ensure harness mocks are installed before tool modules load.
  const { createOpenClawTools } = await import("./openclaw-tools.js");
  const tool = createOpenClawTools(opts).find((candidate) => candidate.name === "sessions_spawn");
  if (!tool) {
    throw new Error("missing sessions_spawn tool");
  }
  return tool;
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));
// Some tools import callGateway via "../../gateway/call.js" (from nested folders). Mock that too.
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});

// Same module, different specifier (used by tools under src/agents/tools/*).
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.configOverride,
    resolveGatewayPort: () => 18789,
  };
});
