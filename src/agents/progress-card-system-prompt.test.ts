import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { appendIncognitoSystemPrompt } from "./incognito-system-prompt.js";
import { appendProgressCardSystemPrompt } from "./progress-card-system-prompt.js";

const { hasPairedCardRenderer } = vi.hoisted(() => ({
  hasPairedCardRenderer: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../infra/device-pairing.js", () => ({ hasPairedCardRenderer }));

function append(params: {
  config?: Parameters<typeof appendProgressCardSystemPrompt>[0]["config"];
  extraSystemPrompt?: string;
  sessionKey?: string;
  toolsAllow?: string[];
}) {
  return appendProgressCardSystemPrompt({
    agentId: "main",
    config: params.config,
    extraSystemPrompt: params.extraSystemPrompt,
    modelId: "gpt-5.6-sol",
    provider: "openai",
    sessionKey: params.sessionKey ?? "agent:main:work",
    toolsAllow: params.toolsAllow,
  });
}

describe("progress card system prompt", () => {
  beforeEach(() => {
    hasPairedCardRenderer.mockReset().mockResolvedValue(true);
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
      name: "the runtime allowlist excludes progress_card",
      params: { toolsAllow: ["read"] },
    },
  ])("suppresses the instruction when $name", async ({ params }) => {
    await expect(append(params)).resolves.toBeUndefined();
  });

  it.each([{ config: { session: { scope: "global" as const } }, sessionKey: "global" }])(
    "suppresses the instruction for the agent main session $sessionKey",
    async (params) => {
      await expect(append(params)).resolves.toBeUndefined();
      expect(hasPairedCardRenderer).not.toHaveBeenCalled();
    },
  );

  it("suppresses the instruction when the attempt uses the resolved utility model", async () => {
    await expect(
      append({
        config: { agents: { defaults: { utilityModel: "openai/gpt-5.6-sol" } } },
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves incognito-first composition order", async () => {
    const incognitoPrompt = appendIncognitoSystemPrompt({
      agentId: "main",
      extraSystemPrompt: "Existing context.",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });

    expect(incognitoPrompt).not.toBe("Existing context.");
    const instruction = await append({});
    await expect(append({ extraSystemPrompt: incognitoPrompt })).resolves.toBe(
      `${incognitoPrompt?.trim()}\n\n${instruction}`,
    );
  });
});
