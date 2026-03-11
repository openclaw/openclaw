import { describe, expect, it, vi } from "vitest";

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...actual,
    resolveExecApprovals: vi.fn(),
  };
});

import { resolveExecApprovals } from "../infra/exec-approvals.js";
import { resolveExecHostApprovalContext } from "./bash-tools.exec-host-shared.js";

const resolveExecApprovalsMock = vi.mocked(resolveExecApprovals);

function stubApprovals(overrides: {
  security?: "deny" | "allowlist" | "full";
  ask?: "off" | "on-miss" | "always";
  askFallback?: "deny" | "allowlist" | "full";
}) {
  resolveExecApprovalsMock.mockReturnValue({
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "",
    defaults: {
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agent: {
      security: overrides.security ?? "allowlist",
      ask: overrides.ask ?? "on-miss",
      askFallback: overrides.askFallback ?? "deny",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: { agents: {} },
  });
}

describe("resolveExecHostApprovalContext", () => {
  it("returns ask=off when params.ask is off and agent.ask is on-miss", () => {
    stubApprovals({ ask: "on-miss" });

    const result = resolveExecHostApprovalContext({
      security: "allowlist",
      ask: "off",
      host: "node",
    });

    expect(result.hostAsk).toBe("off");
  });

  it("returns ask=off when agent.ask is off and params.ask is on-miss", () => {
    stubApprovals({ ask: "off" });

    const result = resolveExecHostApprovalContext({
      security: "allowlist",
      ask: "on-miss",
      host: "node",
    });

    expect(result.hostAsk).toBe("off");
  });

  it("returns ask=off when both params.ask and agent.ask are off", () => {
    stubApprovals({ ask: "off" });

    const result = resolveExecHostApprovalContext({
      security: "allowlist",
      ask: "off",
      host: "node",
    });

    expect(result.hostAsk).toBe("off");
  });

  it("returns the stricter ask when neither side is off", () => {
    stubApprovals({ ask: "always" });

    const result = resolveExecHostApprovalContext({
      security: "allowlist",
      ask: "on-miss",
      host: "gateway",
    });

    expect(result.hostAsk).toBe("always");
  });

  it("throws when resolved security is deny", () => {
    stubApprovals({ security: "deny" });

    expect(() =>
      resolveExecHostApprovalContext({
        security: "full",
        ask: "on-miss",
        host: "node",
      }),
    ).toThrow("exec denied");
  });
});
