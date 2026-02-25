import { describe, expect, it } from "vitest";
import type { ActiviConfig } from "../config/config.js";
import { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox.js";

describe("resolveSandboxContext", () => {
  it("does not sandbox the agent main session in non-main mode", async () => {
    const cfg: ActiviConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/activi-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("does not create a sandbox workspace for the agent main session in non-main mode", async () => {
    const cfg: ActiviConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/activi-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("treats main session aliases as main in non-main mode", async () => {
    const cfg: ActiviConfig = {
      session: { mainKey: "work" },
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "main",
        workspaceDir: "/tmp/activi-test",
      }),
    ).toBeNull();

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/activi-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "work",
        workspaceDir: "/tmp/activi-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/activi-test",
      }),
    ).toBeNull();
  }, 15_000);
});
