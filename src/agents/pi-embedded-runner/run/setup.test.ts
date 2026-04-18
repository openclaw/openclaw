import { describe, expect, it } from "vitest";
import { resolveHookModelSelection, resolvePreferredRunAuthProfile } from "./setup.js";

describe("resolveHookModelSelection", () => {
  it("returns authProfileOverride from before_model_resolve", async () => {
    const selection = await resolveHookModelSelection({
      prompt: "hello",
      provider: "openai",
      modelId: "gpt-5.4",
      hookContext: {
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
      },
      hookRunner: {
        hasHooks: (hookName) => hookName === "before_model_resolve",
        runBeforeModelResolve: async () => ({
          providerOverride: "z-ai",
          modelOverride: "glm-5.1",
          authProfileOverride: "z-ai:work",
        }),
        runBeforeAgentStart: async () => undefined,
      },
    });

    expect(selection).toEqual(
      expect.objectContaining({
        provider: "z-ai",
        modelId: "glm-5.1",
        authProfileOverride: "z-ai:work",
      }),
    );
  });

  it("keeps explicit authProfileOverride ahead of legacy before_agent_start fallback", async () => {
    const selection = await resolveHookModelSelection({
      prompt: "hello",
      provider: "openai",
      modelId: "gpt-5.4",
      hookContext: {
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
      },
      hookRunner: {
        hasHooks: () => true,
        runBeforeModelResolve: async () => ({
          authProfileOverride: "openai:work",
        }),
        runBeforeAgentStart: async () => ({
          authProfileOverride: "openai:legacy",
        }),
      },
    });

    expect(selection.authProfileOverride).toBe("openai:work");
  });
});

describe("resolvePreferredRunAuthProfile", () => {
  it("prefers hook-selected auth profiles when the session is not user-pinned", () => {
    expect(
      resolvePreferredRunAuthProfile({
        requestedAuthProfileId: "openai:old",
        requestedAuthProfileIdSource: "auto",
        hookAuthProfileOverride: "openai:work",
      }),
    ).toEqual({
      preferredProfileId: "openai:work",
      preferredProfileIdSource: "auto",
    });
  });

  it("keeps user-pinned auth profiles ahead of hook preferences", () => {
    expect(
      resolvePreferredRunAuthProfile({
        requestedAuthProfileId: "openai:user-pin",
        requestedAuthProfileIdSource: "user",
        hookAuthProfileOverride: "openai:work",
      }),
    ).toEqual({
      preferredProfileId: "openai:user-pin",
      preferredProfileIdSource: "user",
    });
  });
});
