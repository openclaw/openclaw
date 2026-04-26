import { describe, expect, it, vi } from "vitest";
import {
  buildBeforeModelResolveAttachments,
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
        authProfileOverride: "vision-provider:work",
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
    expect(result.authProfileOverride).toBe("vision-provider:work");
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

  it("lets before_model_resolve auth profile override beat legacy fallback", async () => {
    const hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) =>
          hookName === "before_model_resolve" || hookName === "before_agent_start",
      ),
      runBeforeModelResolve: vi.fn(async () => ({
        authProfileOverride: "openai-codex:work",
      })),
      runBeforeAgentStart: vi.fn(async () => ({
        authProfileOverride: "openai-codex:legacy",
      })),
    };

    const result = await resolveHookModelSelection({
      prompt: "route this",
      provider: "openai-codex",
      modelId: "gpt-5.4",
      hookRunner,
      hookContext,
    });

    expect(result.authProfileOverride).toBe("openai-codex:work");
  });

  it("uses legacy before_agent_start auth profile override when the new hook omits it", async () => {
    const hookRunner = {
      hasHooks: vi.fn(
        (hookName: string) =>
          hookName === "before_model_resolve" || hookName === "before_agent_start",
      ),
      runBeforeModelResolve: vi.fn(async () => ({
        modelOverride: "gpt-5.4",
      })),
      runBeforeAgentStart: vi.fn(async () => ({
        authProfileOverride: "openai-codex:legacy",
      })),
    };

    const result = await resolveHookModelSelection({
      prompt: "route this",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      hookRunner,
      hookContext,
    });

    expect(result.modelId).toBe("gpt-5.4");
    expect(result.authProfileOverride).toBe("openai-codex:legacy");
  });
});

describe("resolvePreferredRunAuthProfile", () => {
  it("prefers a hook auth profile as an automatic selection", () => {
    expect(
      resolvePreferredRunAuthProfile({
        requestedAuthProfileId: "openai-codex:plus",
        requestedAuthProfileIdSource: "auto",
        hookAuthProfileOverride: "openai-codex:pro",
      }),
    ).toEqual({
      preferredProfileId: "openai-codex:pro",
      preferredProfileIdSource: "auto",
    });
  });

  it("does not override a user-pinned auth profile", () => {
    expect(
      resolvePreferredRunAuthProfile({
        requestedAuthProfileId: "openai-codex:plus",
        requestedAuthProfileIdSource: "user",
        hookAuthProfileOverride: "openai-codex:pro",
      }),
    ).toEqual({
      preferredProfileId: "openai-codex:plus",
      preferredProfileIdSource: "user",
    });
  });
});
