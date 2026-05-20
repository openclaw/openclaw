import { describe, expect, it } from "vitest";
import { AcpxRuntime, testing } from "./runtime.js";

type Resolve = (agentName: string) => string | undefined;

function scopedRegistry(
  resolve: Resolve,
  options: Record<string, unknown> = {},
): { resolve(agentName: string): string | undefined } {
  const runtime = new AcpxRuntime({
    cwd: "/tmp",
    sessionStore: { load: async () => undefined, save: async () => {} },
    agentRegistry: { resolve, list: () => [] },
    permissionMode: "approve-reads",
    ...options,
  } as unknown as ConstructorParameters<typeof AcpxRuntime>[0]);
  return (
    runtime as unknown as {
      scopedAgentRegistry: { resolve(agentName: string): string | undefined };
    }
  ).scopedAgentRegistry;
}

describe("ACP harness provider-env scrub (scoped agent registry)", () => {
  it("strips Anthropic creds from the claude harness launch command", () => {
    const registry = scopedRegistry((agent) =>
      agent === "claude" ? 'node "/tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs"' : agent,
    );
    const command = registry.resolve("claude");
    expect(command).toContain("env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN");
    expect(command).toContain("claude-agent-acp-wrapper.mjs");
  });

  it("strips OpenAI creds from the codex harness launch command", () => {
    const registry = scopedRegistry((agent) =>
      agent === "codex" ? 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"' : agent,
    );
    expect(registry.resolve("codex")).toContain("env -u OPENAI_API_KEY -u OPENAI_AUTH_TOKEN");
  });

  it("strips Google creds from the gemini harness launch command", () => {
    const registry = scopedRegistry((agent) => (agent === "gemini" ? "gemini-acp" : agent));
    const command = registry.resolve("gemini");
    expect(command).toContain("-u GEMINI_API_KEY");
    expect(command).toContain("-u GOOGLE_API_KEY");
    expect(command).toContain("-u GOOGLE_AUTH_TOKEN");
  });

  it("never scrubs the openclaw bridge runtime", () => {
    const registry = scopedRegistry((agent) => (agent === "openclaw" ? "openclaw acp" : agent));
    expect(registry.resolve("openclaw")).toBe("openclaw acp");
  });

  it("leaves the command untouched when scrubProviderEnv is disabled", () => {
    const registry = scopedRegistry(
      (agent) =>
        agent === "claude" ? 'node "/tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs"' : agent,
      { openclawScrubProviderEnv: false },
    );
    expect(registry.resolve("claude")).toBe(
      'node "/tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs"',
    );
  });
});

describe("ACP command classification tolerates the env -u scrub prefix", () => {
  it("still classifies a scrubbed claude command", () => {
    expect(
      testing.isClaudeAcpCommand(
        'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN node "/x/claude-agent-acp-wrapper.mjs"',
      ),
    ).toBe(true);
  });

  it("still classifies a scrubbed + leased codex command", () => {
    expect(
      testing.isCodexAcpCommand(
        'env -u OPENAI_API_KEY OPENCLAW_ACPX_LEASE_ID=L node "/x/codex-acp-wrapper.mjs"',
      ),
    ).toBe(true);
  });
});
