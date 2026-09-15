import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../../cli/deps.types.js";

const mocks = vi.hoisted(() => {
  const demand = vi.fn<(name: string) => void>();
  return {
    demand,
    unusedRuntime(name: string) {
      demand(name);
      return {};
    },
    deliverAgentCommandResult: vi.fn(),
    isAcpEnabledByPolicy: vi.fn(),
    getRemoteSkillEligibility: vi.fn(),
    resolveReusableWorkspaceSkillSnapshot: vi.fn(),
    createDefaultDeps: vi.fn<() => CliDeps>(() => ({})),
  };
});

vi.mock("./attempt-execution.runtime.js", () => mocks.unusedRuntime("attempt-execution"));
vi.mock("../../acp/control-plane/manager.js", () => {
  mocks.demand("acp-manager");
  throw new Error("runtime module unavailable");
});
vi.mock("../../acp/policy.js", () => {
  mocks.demand("acp-policy");
  return { isAcpEnabledByPolicy: mocks.isAcpEnabledByPolicy };
});
vi.mock("../../acp/runtime/errors.js", () => mocks.unusedRuntime("acp-errors"));
vi.mock("@openclaw/acp-core/runtime/session-identifiers", () =>
  mocks.unusedRuntime("acp-session-identifiers"),
);
vi.mock("./delivery.runtime.js", () => {
  mocks.demand("delivery");
  return { deliverAgentCommandResult: mocks.deliverAgentCommandResult };
});
vi.mock("./session-store.runtime.js", () => mocks.unusedRuntime("session-store"));
vi.mock("./cli-compaction.js", () => mocks.unusedRuntime("cli-compaction"));
vi.mock("../../auto-reply/reply/agent-runner-memory.js", () =>
  mocks.unusedRuntime("agent-runner-memory"),
);
vi.mock("../../config/sessions/transcript-resolve.runtime.js", () =>
  mocks.unusedRuntime("transcript-resolve"),
);
vi.mock("../../config/sessions/transcript.runtime.js", () =>
  mocks.unusedRuntime("transcript-append"),
);
vi.mock("../../cli/deps.js", () => {
  mocks.demand("cli-deps");
  return { createDefaultDeps: mocks.createDefaultDeps };
});
vi.mock("../exec-defaults.js", () => mocks.unusedRuntime("exec-defaults"));
vi.mock("../../skills/runtime/remote.js", () => {
  mocks.demand("remote-skills");
  return { getRemoteSkillEligibility: mocks.getRemoteSkillEligibility };
});
vi.mock("../../skills/runtime/session-snapshot.js", () => {
  mocks.demand("skill-snapshot");
  return { resolveReusableWorkspaceSkillSnapshot: mocks.resolveReusableWorkspaceSkillSnapshot };
});

let runtime: typeof import("./runtime-loaders.js");
let coldDemands: string[];

beforeAll(async () => {
  runtime = await import("./runtime-loaders.js");
  // Capture before any case demands a loader, independent of case ordering.
  coldDemands = mocks.demand.mock.calls.map(([name]) => name);
});

describe("agent command runtime loaders", () => {
  it("keeps runtime dependencies cold when the command loader module is imported", () => {
    expect(coldDemands).toEqual([]);
  });

  it("shares concurrent and settled promises without sharing different runtime slots", async () => {
    const first = runtime.loadDeliveryRuntime();
    expect(runtime.loadDeliveryRuntime()).toBe(first);
    const delivery = await first;
    expect(delivery.deliverAgentCommandResult).toBe(mocks.deliverAgentCommandResult);
    expect(runtime.loadDeliveryRuntime()).toBe(first);
    await expect(runtime.loadDeliveryRuntime()).resolves.toBe(delivery);

    const policy = runtime.loadAcpPolicyRuntime();
    expect(policy).not.toBe(first);
    expect((await policy).isAcpEnabledByPolicy).toBe(mocks.isAcpEnabledByPolicy);
  });

  it("drops a failed wrapper promise even when its module remains unavailable", async () => {
    const first = runtime.loadAcpManagerRuntime();
    expect(runtime.loadAcpManagerRuntime()).toBe(first);
    await expect(first).rejects.toThrow();

    const next = runtime.loadAcpManagerRuntime();
    expect(next).not.toBe(first);
    // Module evaluation may remain cached as failed; only wrapper eviction is promised.
    await expect(next).rejects.toThrow();
    expect(mocks.demand).toHaveBeenCalledWith("acp-manager");
  });

  it("lazily composes the two skill functions in a shared result", async () => {
    expect(mocks.demand).not.toHaveBeenCalledWith("remote-skills");
    expect(mocks.demand).not.toHaveBeenCalledWith("skill-snapshot");
    const first = runtime.loadSkillsRuntime();
    expect(runtime.loadSkillsRuntime()).toBe(first);
    const skills = await first;
    expect(Object.keys(skills)).toEqual([
      "getRemoteSkillEligibility",
      "resolveReusableWorkspaceSkillSnapshot",
    ]);
    expect(skills.getRemoteSkillEligibility).toBe(mocks.getRemoteSkillEligibility);
    expect(skills.resolveReusableWorkspaceSkillSnapshot).toBe(
      mocks.resolveReusableWorkspaceSkillSnapshot,
    );
    expect(runtime.loadSkillsRuntime()).toBe(first);
  });

  it("keeps supplied CLI deps cold and creates fresh defaults for each omitted value", async () => {
    const supplied: CliDeps = {};
    await expect(runtime.resolveAgentCommandDeps(supplied)).resolves.toBe(supplied);
    expect(mocks.demand).not.toHaveBeenCalledWith("cli-deps");
    expect(mocks.createDefaultDeps).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      runtime.resolveAgentCommandDeps(undefined),
      runtime.resolveAgentCommandDeps(undefined),
    ]);
    const third = await runtime.resolveAgentCommandDeps(undefined);
    expect(first).not.toBe(second);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    expect(mocks.createDefaultDeps).toHaveBeenCalledTimes(3);
    expect(mocks.demand.mock.calls.filter(([name]) => name === "cli-deps")).toHaveLength(1);
  });
});
