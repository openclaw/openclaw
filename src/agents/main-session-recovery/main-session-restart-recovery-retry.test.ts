import { WorkerTaskError } from "@openclaw/worker-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../agent-scope-config.js";
import { resolveRestartRecoveryDispatchTarget } from "./main-session-restart-recovery-target.js";

const io = vi.hoisted(() => ({ resolve: vi.fn(), warn: vi.fn() }));
vi.mock("../../gateway/session-store-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/session-store-key.js")>()),
  resolveSessionStoreIdentity: io.resolve,
}));
vi.mock("../subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../subagents/registry/subagent-registry-read.js")>()),
  listSubagentRunsForRequester: () => [],
}));
vi.mock("./main-session-restart-recovery-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./main-session-restart-recovery-shared.js")>()),
  mainSessionRecoveryLog: { warn: io.warn },
}));

const target = {
  cfg: { session: { store: "/configured/agents/{agentId}/sessions/sessions.json" } },
  sessionKey: "agent:main:main",
  storePath: "/retained/agents/main/sessions/sessions.json",
};

beforeEach(() => {
  vi.resetAllMocks();
  io.resolve.mockReturnValue({ agentId: "main", canonicalKey: "agent:main:main" });
});

it.each(["overloaded", "unavailable", "timeout"] as const)(
  "propagates %s resolution failures to the existing retry scheduler",
  async (code) => {
    const error = new WorkerTaskError("Target reader busy", code);
    io.resolve.mockImplementation(() => {
      throw error;
    });
    await expect(resolveRestartRecoveryDispatchTarget(target)).rejects.toBe(error);
  },
);

it("keeps a genuinely mismatched store skipped", async () => {
  await expect(resolveRestartRecoveryDispatchTarget(target)).resolves.toBeUndefined();
});

it("keeps an absent logical owner skipped with its diagnostic", async () => {
  io.resolve.mockImplementation(() => {
    throw new AgentSelectionRequiredError([]);
  });
  await expect(resolveRestartRecoveryDispatchTarget(target)).resolves.toBeUndefined();
  expect(io.warn).toHaveBeenCalledWith(expect.stringContaining("AgentSelectionRequiredError"));
});
