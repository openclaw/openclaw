import { describe, expect, it, vi } from "vitest";
import {
  buildBeforeModelResolveAttachments,
  resolveCurrentRunAuthProfile,
  resolveHookModelSelection,
  resolvePreferredRunAuthProfile,
} from "./setup.js";

const hookContext = {
  sessionId: "session-1",
  workspaceDir: "/tmp/workspace",
};

describe("buildBeforeModelResolveAttachments", () => {
  it("maps prompt image metadata to before_model_resolve attachments", () => {
    expect(
      buildBeforeModelResolveAttachments([{ mimeType: "image/png" }, { mimeType: "image/jpeg" }]),
    ).toEqual([
      { kind: "image", mimeType: "image/png" },
      { kind: "image", mimeType: "image/jpeg" },
    ]);
  });

  it("omits attachments when there are no images", () => {
    expect(buildBeforeModelResolveAttachments(undefined)).toBeUndefined();
    expect(buildBeforeModelResolveAttachments([])).toBeUndefined();
  });
});

describe("resolveHookModelSelection", () => {
  it("passes attachment metadata to before_model_resolve hooks", async () => {
    const attachments = [{ kind: "image" as const, mimeType: "image/png" }];
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => ({
        providerOverride: "vision-provider",
        modelOverride: "vision-model",
      })),
      runBeforeAgentStart: vi.fn(),
    };

    const result = await resolveHookModelSelection({
      prompt: "describe this image",
      attachments,
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "describe this image", attachments },
      hookContext,
    );
    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result.provider).toBe("vision-provider");
    expect(result.modelId).toBe("vision-model");
  });

  it("omits the attachments key for text-only before_model_resolve hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(),
    };

    await resolveHookModelSelection({
      prompt: "text only",
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "text only" },
      hookContext,
    );
  });

  it("returns authProfileOverride from before_model_resolve", async () => {
    const selection = await resolveHookModelSelection({
      prompt: "hello",
      provider: "openai",
      modelId: "gpt-5.4",
      hookContext,
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
      hookContext,
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

describe("resolveCurrentRunAuthProfile", () => {
  it("tracks the active rotated profile instead of a stale preferred profile", () => {
    expect(
      resolveCurrentRunAuthProfile({
        activeAuthProfileId: "openai:rotated",
      }),
    ).toEqual({
      authProfileId: "openai:rotated",
      authProfileIdSource: "auto",
    });
  });

  it("preserves user source for locked profiles", () => {
    expect(
      resolveCurrentRunAuthProfile({
        activeAuthProfileId: "openai:user-pin",
        lockedProfileId: "openai:user-pin",
      }),
    ).toEqual({
      authProfileId: "openai:user-pin",
      authProfileIdSource: "user",
    });
  });
});
