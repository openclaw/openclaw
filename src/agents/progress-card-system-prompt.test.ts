import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { prepareAttemptSystemPromptAdditions } from "./embedded-agent-runner/run/attempt-system-prompt-additions.js";

const { hasPairedCardRenderer } = vi.hoisted(() => ({
  hasPairedCardRenderer: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../infra/device-pairing.js", () => ({ hasPairedCardRenderer }));
vi.mock("./git-coauthor-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-coauthor-prompt.js")>()),
  resolveSessionGitCoauthorPrompt: async () => undefined,
}));

async function append(params: {
  config?: Parameters<typeof prepareAttemptSystemPromptAdditions>[0]["config"];
  extraSystemPrompt?: string;
  sessionKey?: string;
  toolsAllow?: string[];
  storePath?: string;
}) {
  return (
    await prepareAttemptSystemPromptAdditions({
      agentId: "main",
      sessionId: "synthetic-session",
      config: params.config,
      extraSystemPrompt: params.extraSystemPrompt,
      modelId: "gpt-5.6-sol",
      provider: "openai",
      sessionKey: params.sessionKey ?? "agent:main:work",
      toolsAllow: params.toolsAllow,
      storePath: params.storePath,
    })
  ).extraSystemPrompt;
}

describe("progress card system prompt", () => {
  beforeEach(() => {
    hasPairedCardRenderer.mockReset().mockResolvedValue(true);
  });

  it("injects the instruction when every adoption gate passes", async () => {
    await expect(append({})).resolves.toContain("progress_card");
  });

  it.each([
    {
      name: "the progress-card kill switch is disabled",
      params: { config: { tools: { updatePlan: false } } },
    },
    {
      name: "progress_card is denied",
      params: { config: { tools: { deny: ["progress_card"] } } },
    },
    {
      name: "the configured profile excludes progress_card",
      params: { config: { tools: { profile: "messaging" as const } } },
    },
    {
      name: "the runtime allowlist excludes progress_card",
      params: { toolsAllow: ["read"] },
    },
  ])("suppresses the instruction when $name", async ({ params }) => {
    await expect(append(params)).resolves.toBeUndefined();
  });

  it.each([
    { config: undefined, sessionKey: "main" },
    { config: { session: { scope: "global" as const } }, sessionKey: "global" },
  ])("suppresses the instruction for the agent main session $sessionKey", async (params) => {
    await expect(append(params)).resolves.toBeUndefined();
    expect(hasPairedCardRenderer).not.toHaveBeenCalled();
  });

  it("suppresses the instruction when no paired client can render the card", async () => {
    hasPairedCardRenderer.mockResolvedValue(false);

    await expect(append({})).resolves.toBeUndefined();
  });

  it("suppresses the instruction when the attempt uses the resolved utility model", async () => {
    await expect(
      append({
        config: { agents: { defaults: { utilityModel: "openai/gpt-5.6-sol" } } },
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves incognito-first composition order", async () => {
    expect(
      await append({
        extraSystemPrompt: "Existing context.",
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
      }),
    ).toBe(
      "Existing context.\n\nThis chat is incognito; do not store its conversation content in memory files or long-term notes.\n\nCreate a card with progress_card only for substantial work with at least two meaningful sequential steps, never for greetings, quick questions, or single-step requests. For measurable work with a known total, prefer a leading progress bar labeled with what is measured and observed completed/total counts; never invent percentages. Update or clear existing cards as needed.",
    );
  });
});
