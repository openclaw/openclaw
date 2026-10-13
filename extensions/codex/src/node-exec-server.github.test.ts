import { describe, expect, it, vi } from "vitest";
import { createCodexNodeExecServerInvokePolicy } from "./node-exec-server.js";

describe("Codex node GitHub launch binding", () => {
  it("carries a validated binding only through the approved node launch", async () => {
    const placement = {
      cwd: process.cwd(),
      environmentId: "paired-environment",
      sessionId: "paired-session",
      ownerEpoch: 1,
      sessionKey: "agent:main:paired-session",
    };
    const github = {
      token: "synthetic-node-installation-token",
      login: "worker-bot",
      branch: "openclaw/session-worker",
      host: "fixture.ghe.com",
      remoteUrl: "https://fixture.ghe.com/example/repo.git",
    };
    const invokeNodeWithSessionFull = vi.fn(async ({ createParams }) => ({
      ok: true as const,
      payload: createParams(),
    }));

    await expect(
      createCodexNodeExecServerInvokePolicy().handle({
        nodeId: "paired-node",
        command: "codex.exec-server.stdio.v1",
        params: { ...placement, github },
        config: {},
        risk: { level: "high", family: "codex.exec-server" },
        invokeNode: vi.fn(),
        invokeNodeWithSessionFull,
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { placement, authorization: "session-full", github },
    });
    await expect(
      createCodexNodeExecServerInvokePolicy().handle({
        nodeId: "paired-node",
        command: "codex.exec-server.stdio.v1",
        params: {
          ...placement,
          github: { ...github, remoteUrl: "https://outside.test/example/repo.git" },
        },
        config: {},
        risk: { level: "high", family: "codex.exec-server" },
        invokeNode: vi.fn(),
        invokeNodeWithSessionFull,
      }),
    ).resolves.toMatchObject({ ok: false, code: "CODEX_NODE_EXEC_GITHUB_BINDING_INVALID" });
  });
});
