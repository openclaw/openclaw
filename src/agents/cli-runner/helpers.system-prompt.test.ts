import { Type } from "typebox";
// Verifies CLI system-prompt construction without loading the full runner.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { resolveSessionGitCoauthorPrompt } from "../git-coauthor-prompt.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { buildCliAgentSystemPrompt } from "./helpers.js";
import { prepareCliSystemPrompt } from "./prompt-context.js";

vi.mock("../git-coauthor-prompt.js", () => ({
  resolveSessionGitCoauthorPrompt: vi.fn(),
}));

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

describe("buildCliAgentSystemPrompt", () => {
  afterEach(() => {
    clearPluginCommands();
    vi.mocked(resolveSessionGitCoauthorPrompt).mockReset();
  });

  it("prepares session credit before rendering the CLI system prompt", async () => {
    const gitCoauthorPrompt =
      "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
      "Co-authored-by: ada <20+ada@users.noreply.github.com>";
    vi.mocked(resolveSessionGitCoauthorPrompt).mockResolvedValue(gitCoauthorPrompt);
    const config = {};
    const prompt = await prepareCliSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config,
      agentId: "main",
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain(gitCoauthorPrompt);
    expect(resolveSessionGitCoauthorPrompt).toHaveBeenCalledExactlyOnceWith({
      config,
      agentId: "main",
      sessionKey: "agent:main:shared",
      sessionId: "shared-session",
    });
  });

  it("includes the OpenClaw skills prompt in CLI system prompts", () => {
    const preparedModelRuntime = {
      isCurrent: vi.fn(() => true),
      configuredModelAliases: [{ alias: "Current", provider: "fixture", model: "current" }],
    };
    const params = {
      workspaceDir: "/tmp",
      modelDisplay: "claude-cli/sonnet",
      config: { agents: { defaults: { model: "fixture/current" } } },
      preparedModelRuntime,
      tools: [],
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>weather</name>",
        "    <description>Use weather tools.</description>",
        "    <location>/tmp/skills/weather/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    };
    const systemPrompt = buildCliAgentSystemPrompt(params);

    expect(systemPrompt).toContain("<name>weather</name>");
    expect(systemPrompt).toContain("- Current: fixture/current");
    preparedModelRuntime.isCurrent.mockReturnValue(false);
    expect(buildCliAgentSystemPrompt(params)).not.toContain("## Model Aliases");
  });

  it.each([true])("gates ClawHub guidance on the CLI tool schema (available=%s)", (available) => {
    const message = createStubTool("message");
    message.parameters = Type.Object(
      available ? { clawhub: Type.Object({ query: Type.String() }) } : {},
    );
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [message],
      runtimeChannel: "webchat",
      modelDisplay: "test/model",
    });

    expect(prompt.includes("For explicit plugin/skill search/install or missing capability")).toBe(
      available,
    );
  });

  it("uses config-backed sub-agent delegation mode", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      tools: [{ name: "sessions_spawn" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Delegation");
  });

  it("includes CLI-scoped plugin command guidance", () => {
    // Plugin command guidance is surface-filtered; CLI prompts must not leak
    // OpenClaw-main command text into external CLI backends.
    registerPluginCommand("demo-plugin", {
      name: "demo_cli",
      description: "Demo CLI command",
      agentPromptGuidance: [
        {
          text: "CLI-only command guidance.",
          surfaces: ["cli_backend"],
        },
        {
          text: "OpenClaw-only command guidance.",
          surfaces: ["openclaw_main"],
        },
      ],
      handler: async () => ({ text: "ok" }),
    });

    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "exec" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("CLI-only command guidance.");
    expect(prompt).not.toContain("OpenClaw-only command guidance.");
  });

  it.each(["slack"])("preserves %s channel-owned button guidance", (channel) => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [createStubTool("message")],
      modelDisplay: "test/model",
      runtimeChannel: channel,
      runtimeCapabilities: ["inlineButtons"],
      customInlineButtonHint: true,
      messageToolHints: ["- Use the channel's supported button shape."],
    });

    expect(prompt).toContain("- Use the channel's supported button shape.");
    expect(prompt).not.toContain('"action":{"type":"callback"');
    expect(prompt).not.toContain("Inline buttons OFF");
  });
});
