/**
 * Tests agent-specific exec defaults in assembled coding tools.
 * Verifies per-agent exec host policy affects lazy exec/process behavior.
 */
import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

function createExecHostDefaultsConfig(
  agents: Array<{ id: string; execHost?: "auto" | "gateway" | "sandbox" }>,
): OpenClawConfig {
  return {
    tools: {
      exec: {
        host: "auto",
        security: "full",
        ask: "off",
      },
    },
    agents: {
      list: agents.map((agent) => ({
        id: agent.id,
        ...(agent.execHost
          ? {
              tools: {
                exec: {
                  host: agent.execHost,
                },
              },
            }
          : {}),
      })),
    },
  };
}

function requireExecTool(tools: ReturnType<typeof createOpenClawCodingTools>) {
  const execTool = tools.find((tool) => tool.name === "exec");
  if (!execTool) {
    throw new Error("expected exec tool");
  }
  return execTool;
}

function printEnvCommand(key: string): string {
  const script = `process.stdout.write(process.env[${JSON.stringify(key)}] ?? "missing")`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe("Agent-specific exec tool defaults", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("should run exec synchronously when process is denied", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        deny: ["process"],
        exec: {
          host: "gateway",
          security: "full",
          ask: "off",
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main",
      agentDir: "/tmp/agent-main",
    });
    const execTool = requireExecTool(tools);

    const result = await execTool.execute("call1", {
      command: "echo done",
      yieldMs: 10,
    });

    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("routes implicit auto exec to gateway without a sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-implicit-gateway",
      agentDir: "/tmp/agent-main-implicit-gateway",
    });
    const execTool = requireExecTool(tools);

    const result = await execTool.execute("call-implicit-auto-default", {
      command: "echo done",
    });
    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("passes normalized exec mode defaults into the exec tool", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "deny",
          },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-mode-deny",
      agentDir: "/tmp/agent-main-mode-deny",
    });
    const execTool = requireExecTool(tools);

    await expect(
      execTool.execute("call-mode-deny", {
        command: "echo blocked",
      }),
    ).rejects.toThrow("security=deny");
  });

  it("ignores per-call legacy security when configured mode is full", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "full",
          },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-mode-call-security",
      agentDir: "/tmp/agent-main-mode-call-security",
    });
    const execTool = requireExecTool(tools);

    const result = await execTool.execute("call-mode-security-deny", {
      command: "echo allowed",
      security: "deny",
    });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("allowed");
  });

  it("preserves mode-derived security for partial agent exec overrides", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "auto",
            safeBins: [],
          },
        },
        agents: {
          list: [
            {
              id: "main",
              tools: {
                exec: {
                  ask: "off",
                },
              },
            },
          ],
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-mode-partial-agent",
      agentDir: "/tmp/agent-main-mode-partial-agent",
    });
    const execTool = requireExecTool(tools);

    await expect(
      execTool.execute("call-mode-partial-agent", {
        command: "echo blocked",
      }),
    ).rejects.toThrow(/allowlist miss/);
  });

  it("lets session legacy exec overrides clear inherited mode", async () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          exec: {
            mode: "auto",
            safeBins: [],
          },
        },
      },
      exec: {
        security: "deny",
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-session-legacy-override",
      agentDir: "/tmp/agent-main-session-legacy-override",
    });
    const execTool = requireExecTool(tools);

    await expect(
      execTool.execute("call-session-legacy-override", {
        command: "echo denied",
      }),
    ).rejects.toThrow("security=deny");
  });

  it("fails closed when exec host=sandbox is requested without sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {},
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-fail-closed",
      agentDir: "/tmp/agent-main-fail-closed",
    });
    const execTool = requireExecTool(tools);
    await expect(
      execTool.execute("call-fail-closed", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("should apply agent-specific exec host defaults over global defaults", async () => {
    const cfg = createExecHostDefaultsConfig([
      { id: "main", execHost: "gateway" },
      { id: "helper" },
    ]);

    const mainTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-exec-defaults",
      agentDir: "/tmp/agent-main-exec-defaults",
    });
    const mainExecTool = requireExecTool(mainTools);
    const mainResult = await mainExecTool.execute("call-main-default", {
      command: "echo done",
      yieldMs: 1000,
    });
    const mainDetails = mainResult?.details as { status?: string } | undefined;
    expect(mainDetails?.status).toBe("completed");
    await expect(
      mainExecTool.execute("call-main", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow("exec host not allowed");

    const helperTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:helper:main",
      workspaceDir: "/tmp/test-helper-exec-defaults",
      agentDir: "/tmp/agent-helper-exec-defaults",
    });
    const helperExecTool = requireExecTool(helperTools);
    const helperResult = await helperExecTool.execute("call-helper-default", {
      command: "echo done",
      yieldMs: 1000,
    });
    const helperDetails = helperResult?.details as { status?: string } | undefined;
    expect(helperDetails?.status).toBe("completed");
    await expect(
      helperExecTool.execute("call-helper", {
        command: "echo done",
        host: "sandbox",
        yieldMs: 1000,
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("applies explicit agentId exec defaults when sessionKey is opaque", async () => {
    const cfg = createExecHostDefaultsConfig([{ id: "main", execHost: "gateway" }]);

    const tools = createOpenClawCodingTools({
      config: cfg,
      agentId: "main",
      sessionKey: "run-opaque-123",
      workspaceDir: "/tmp/test-main-opaque-session",
      agentDir: "/tmp/agent-main-opaque-session",
    });
    const execTool = requireExecTool(tools);
    const result = await execTool.execute("call-main-opaque-session", {
      command: "echo done",
      yieldMs: 1000,
    });
    const details = result?.details as { status?: string } | undefined;
    expect(details?.status).toBe("completed");
  });

  it("injects configured env only into the selected agent and can drop inherited env", async () => {
    if (process.platform === "win32") {
      return;
    }
    const key = "OPENCLAW_TEST_AGENT_SCOPED_EXEC_ENV";
    const previous = process.env[key];
    process.env[key] = "gateway-value";
    try {
      const cfg: OpenClawConfig = {
        tools: { exec: { host: "gateway", security: "full", ask: "off" } },
        agents: {
          list: [
            {
              id: "referrals",
              tools: {
                exec: {
                  inheritHostEnv: false,
                  env: { [key]: "agent-value" },
                },
              },
            },
            {
              id: "helper",
              tools: { exec: { inheritHostEnv: false } },
            },
          ],
        },
      };

      const referralsExec = requireExecTool(
        createOpenClawCodingTools({
          config: cfg,
          agentId: "referrals",
          workspaceDir: "/tmp/test-referrals-env",
          agentDir: "/tmp/agent-referrals-env",
        }),
      );
      const referralsResult = await referralsExec.execute("call-referrals-env", {
        command: printEnvCommand(key),
        env: { [key]: "model-value" },
      });
      expect((referralsResult.content[0] as { text?: string }).text).toContain("agent-value");

      const helperExec = requireExecTool(
        createOpenClawCodingTools({
          config: cfg,
          agentId: "helper",
          workspaceDir: "/tmp/test-helper-env",
          agentDir: "/tmp/agent-helper-env",
        }),
      );
      const helperResult = await helperExec.execute("call-helper-env", {
        command: printEnvCommand(key),
      });
      expect((helperResult.content[0] as { text?: string }).text).toContain("missing");
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("keeps dangerous configured host env keys behind the existing security filter", async () => {
    const execTool = requireExecTool(
      createOpenClawCodingTools({
        config: {
          tools: { exec: { host: "gateway", security: "full", ask: "off" } },
          agents: {
            list: [
              {
                id: "ops",
                tools: { exec: { env: { PATH: "/tmp/untrusted" } } },
              },
            ],
          },
        },
        agentId: "ops",
        workspaceDir: "/tmp/test-ops-env-filter",
        agentDir: "/tmp/agent-ops-env-filter",
      }),
    );

    await expect(
      execTool.execute("call-ops-env-filter", { command: "echo blocked" }),
    ).rejects.toThrow("PATH is controlled by tools.exec.pathPrepend");
  });

  it("allows source-config tool inspection but rejects unresolved SecretRefs on execution", async () => {
    const execTool = requireExecTool(
      createOpenClawCodingTools({
        config: {
          tools: { exec: { host: "gateway", security: "full", ask: "off" } },
          agents: {
            list: [
              {
                id: "ops",
                tools: {
                  exec: {
                    env: {
                      SCOPED_CREDENTIAL: {
                        source: "env",
                        provider: "default",
                        id: "OPS_SCOPED_CREDENTIAL",
                      },
                    },
                  },
                },
              },
            ],
          },
        },
        agentId: "ops",
        workspaceDir: "/tmp/test-ops-unresolved-env",
        agentDir: "/tmp/agent-ops-unresolved-env",
      }),
    );

    await expect(
      execTool.execute("call-ops-unresolved-env", { command: "echo blocked" }),
    ).rejects.toThrow("contains an unresolved SecretRef");
  });

  it("rejects attempts to spoof trusted channel context through per-call env", async () => {
    const execTool = requireExecTool(
      createOpenClawCodingTools({
        config: { tools: { exec: { host: "gateway", security: "full", ask: "off" } } },
        agentId: "ops",
        workspaceDir: "/tmp/test-ops-channel-context-env",
        agentDir: "/tmp/agent-ops-channel-context-env",
      }),
    );

    await expect(
      execTool.execute("call-ops-channel-context-env", {
        command: "echo blocked",
        env: { OPENCLAW_CHANNEL_CONTEXT: "spoofed" },
      }),
    ).rejects.toThrow("reserved for trusted channel context");
  });

  it("rejects host-env minimization when effective exec host is a remote node", async () => {
    const execTool = requireExecTool(
      createOpenClawCodingTools({
        config: {
          tools: { exec: { host: "node", security: "full", ask: "off" } },
          agents: {
            list: [{ id: "ops", tools: { exec: { inheritHostEnv: false } } }],
          },
        },
        agentId: "ops",
        workspaceDir: "/tmp/test-ops-node-env",
        agentDir: "/tmp/agent-ops-node-env",
      }),
    );

    await expect(
      execTool.execute("call-ops-node-env", { command: "echo blocked" }),
    ).rejects.toThrow("configure environment isolation on the node host");
  });

  it("rejects agent-scoped env before remote-node preparation", async () => {
    const execTool = requireExecTool(
      createOpenClawCodingTools({
        config: {
          tools: { exec: { host: "node", security: "full", ask: "always" } },
          agents: {
            list: [
              {
                id: "ops",
                tools: { exec: { env: { SCOPED_TOKEN: "must-stay-on-gateway" } } },
              },
            ],
          },
        },
        agentId: "ops",
        workspaceDir: "/tmp/test-ops-node-scoped-env",
        agentDir: "/tmp/agent-ops-node-scoped-env",
      }),
    );

    await expect(
      execTool.execute("call-ops-node-scoped-env", { command: "echo blocked" }),
    ).rejects.toThrow("configure scoped environment on the node host");
  });
});
