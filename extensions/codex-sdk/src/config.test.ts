import { describe, expect, it } from "vitest";
import { createCodexSdkPluginConfigSchema, resolveCodexSdkPluginConfig } from "./config.js";

describe("codex-sdk config", () => {
  it("applies conservative defaults", () => {
    const config = resolveCodexSdkPluginConfig({
      rawConfig: undefined,
      workspaceDir: "/tmp/workspace",
    });

    expect(config).toMatchObject({
      cwd: "/tmp/workspace",
      inheritEnv: true,
      skipGitRepoCheck: false,
      sandboxMode: "workspace-write",
      defaultRoute: "default",
      backchannel: {
        enabled: true,
        name: "openclaw-codex",
        requireWriteToken: true,
        writeTokenEnv: "OPENCLAW_CODEX_BACKCHANNEL_WRITE_TOKEN",
      },
    });
    expect(config.backchannel.allowedMethods).toEqual(
      expect.arrayContaining(["codex.status", "codex.proposal.create"]),
    );
    expect(config.allowedAgents).toEqual(
      expect.arrayContaining([
        "codex",
        "codex-deep",
        "codex-docs",
        "codex-fast",
        "codex-refactor",
        "codex-review",
        "codex-ship",
        "codex-test",
        "codex-worker",
      ]),
    );
    expect(config.routes.deep).toMatchObject({
      label: "codex/deep",
      modelReasoningEffort: "high",
    });
  });

  it("validates enum and path fields", () => {
    const schema = createCodexSdkPluginConfigSchema();

    expect(schema.validate?.({ sandboxMode: "banana" }).ok).toBe(false);
    expect(schema.validate?.({ codexPath: "relative/codex" }).ok).toBe(false);
    expect(schema.validate?.({ backchannel: { name: "bad name" } }).ok).toBe(false);
    expect(schema.validate?.({ approvalPolicy: "on-request" }).ok).toBe(true);
  });

  it("accepts nested Codex config overrides", () => {
    const config = resolveCodexSdkPluginConfig({
      rawConfig: {
        config: {
          show_raw_agent_reasoning: true,
          sandbox_workspace_write: { network_access: false },
        },
      },
    });

    expect(config.config).toEqual({
      show_raw_agent_reasoning: true,
      sandbox_workspace_write: { network_access: false },
    });
  });

  it("accepts backchannel overrides", () => {
    const config = resolveCodexSdkPluginConfig({
      rawConfig: {
        backchannel: {
          name: "openclaw-local",
          gatewayUrl: "ws://127.0.0.1:19999",
          allowedMethods: ["codex.status", "codex.proposal.create", "chat.send"],
          safeWriteMethods: ["codex.proposal.create"],
          requireWriteToken: false,
          requestTimeoutMs: 1500,
        },
      },
    });

    expect(config.backchannel).toMatchObject({
      enabled: true,
      name: "openclaw-local",
      gatewayUrl: "ws://127.0.0.1:19999",
      allowedMethods: ["codex.status", "codex.proposal.create", "chat.send"],
      safeWriteMethods: ["codex.proposal.create"],
      requireWriteToken: false,
      requestTimeoutMs: 1500,
    });
  });

  it("merges custom route overrides into the native route registry", () => {
    const config = resolveCodexSdkPluginConfig({
      rawConfig: {
        defaultRoute: "plan",
        routes: {
          plan: {
            aliases: ["codex-plan", "codex/planner"],
            model: "gpt-5.5",
            modelReasoningEffort: "xhigh",
            instructions: "Plan carefully.",
          },
        },
      },
    });

    expect(config.defaultRoute).toBe("plan");
    expect(config.routes.plan).toMatchObject({
      id: "plan",
      label: "codex/plan",
      aliases: ["codex-plan", "codex-planner"],
      model: "gpt-5.5",
      modelReasoningEffort: "xhigh",
    });
    expect(config.allowedAgents).toContain("codex-plan");
  });

  it("rejects missing default routes and invalid route fields", () => {
    expect(() =>
      resolveCodexSdkPluginConfig({
        rawConfig: {
          defaultRoute: "missing",
        },
      }),
    ).toThrow(/defaultRoute does not exist/);

    expect(() =>
      resolveCodexSdkPluginConfig({
        rawConfig: {
          routes: {
            deep: {
              modelReasoningEffort: "too-much",
            },
          },
        },
      }),
    ).toThrow(/modelReasoningEffort/);
  });
});
