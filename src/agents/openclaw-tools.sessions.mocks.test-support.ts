import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

export const { callGatewayMock } = mocks;

vi.mock("../commands/agent.js", () => ({ agentCommandFromIngress: vi.fn() }));
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    tools: {
      // Keep sessions tools permissive in this suite; dedicated visibility tests cover defaults.
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true },
    },
  }),
  resolveGatewayPort: () => 18789,
}));
