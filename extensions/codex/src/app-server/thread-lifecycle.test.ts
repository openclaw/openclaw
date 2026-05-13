import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  resolveCodexReasoningSummary,
  resolveReasoningEffort,
} from "./thread-lifecycle.js";

function createAttemptParams(params: {
  provider: string;
  authProfileId?: string;
  authProfileProvider?: string;
  authProfileProviders?: Record<string, string>;
  reasoningLevel?: string;
}): EmbeddedRunAttemptParams {
  const authProfileProviders =
    params.authProfileProviders ??
    (params.authProfileId
      ? { [params.authProfileId]: params.authProfileProvider ?? "openai-codex" }
      : {});
  return {
    provider: params.provider,
    modelId: "gpt-5.4",
    authProfileId: params.authProfileId,
    reasoningLevel: params.reasoningLevel,
    authProfileStore: {
      version: 1,
      profiles: Object.fromEntries(
        Object.entries(authProfileProviders).map(([profileId, provider]) => [
          profileId,
          {
            type: "oauth" as const,
            provider,
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        ]),
      ),
    },
  } as EmbeddedRunAttemptParams;
}

function createAppServerOptions() {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  } as const;
}

describe("Codex app-server native code mode config", () => {
  it("enables Codex code-mode-only on thread/start without clobbering other config", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
      config: {
        "features.codex_hooks": true,
        apps: { _default: { enabled: false } },
      },
    });

    expect(request.config).toEqual({
      "features.codex_hooks": true,
      apps: { _default: { enabled: false } },
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
  });

  it("enables Codex code-mode-only on thread/resume", () => {
    const request = buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
      threadId: "thread-1",
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.config).toEqual({
      "features.code_mode": true,
      "features.code_mode_only": true,
    });
  });
});

describe("Codex app-server reasoning summary plumbing", () => {
  it("omits model_reasoning_summary when reasoningLevel is unset (preserves user's codex config.toml)", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });
    expect(request.config).not.toHaveProperty("model_reasoning_summary");
  });

  it("sets model_reasoning_summary=auto on thread/start when reasoningLevel=stream", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "openai", reasoningLevel: "stream" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );
    expect(request.config).toMatchObject({ model_reasoning_summary: "auto" });
  });

  it("sets model_reasoning_summary=auto on thread/start when reasoningLevel=on", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "openai", reasoningLevel: "on" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );
    expect(request.config).toMatchObject({ model_reasoning_summary: "auto" });
  });

  // openclaw defaults a missing reasoningLevel to "off" at several callsites
  // (commands-btw, directive-handling, get-reply-directives), so we cannot
  // distinguish "user explicitly set off" from "openclaw filled in a default".
  // To avoid clobbering a user's `~/.codex/config.toml` setting from a default
  // value, the extension does NOT emit model_reasoning_summary for "off".
  // Users wanting summaries off should set it in codex config.toml directly.
  it("omits model_reasoning_summary on thread/start when reasoningLevel=off (default-or-explicit; preserves codex config.toml)", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "openai", reasoningLevel: "off" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );
    expect(request.config).not.toHaveProperty("model_reasoning_summary");
  });

  it("plumbs model_reasoning_summary on thread/resume as well", () => {
    const request = buildThreadResumeParams(
      createAttemptParams({ provider: "openai", reasoningLevel: "stream" }),
      {
        threadId: "thread-1",
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );
    expect(request.config).toMatchObject({ model_reasoning_summary: "auto" });
  });

  it("does not clobber other config entries when injecting reasoning summary", () => {
    const request = buildThreadStartParams(
      createAttemptParams({ provider: "openai", reasoningLevel: "stream" }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
        config: {
          "features.codex_hooks": true,
          apps: { _default: { enabled: false } },
        },
      },
    );
    expect(request.config).toEqual({
      "features.codex_hooks": true,
      apps: { _default: { enabled: false } },
      "features.code_mode": true,
      "features.code_mode_only": true,
      model_reasoning_summary: "auto",
    });
  });

  describe("resolveCodexReasoningSummary", () => {
    it("maps on → auto", () => {
      expect(resolveCodexReasoningSummary("on")).toBe("auto");
    });
    it("maps stream → auto", () => {
      expect(resolveCodexReasoningSummary("stream")).toBe("auto");
    });
    it("returns undefined for off (cannot distinguish explicit-off from openclaw default)", () => {
      expect(resolveCodexReasoningSummary("off")).toBeUndefined();
    });
    it("returns undefined for unset (preserves codex config.toml defaults)", () => {
      expect(resolveCodexReasoningSummary(undefined)).toBeUndefined();
    });
    it("returns undefined for unknown values (forwards-compat)", () => {
      expect(resolveCodexReasoningSummary("future-value")).toBeUndefined();
    });
  });
});

describe("Codex app-server model provider selection", () => {
  it.each(["openai", "openai-codex"])(
    "omits public %s modelProvider when forwarding native Codex auth on thread/start",
    (provider) => {
      const request = buildThreadStartParams(
        createAttemptParams({ provider, authProfileId: "work" }),
        {
          cwd: "/repo",
          dynamicTools: [],
          appServer: createAppServerOptions() as never,
          developerInstructions: "test instructions",
        },
      );

      expect(request).not.toHaveProperty("modelProvider");
    },
  );

  it("uses the bound native Codex auth profile when deciding thread/resume modelProvider", () => {
    const request = buildThreadResumeParams(
      createAttemptParams({
        provider: "openai",
        authProfileProviders: { bound: "openai-codex" },
      }),
      {
        threadId: "thread-1",
        authProfileId: "bound",
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request).not.toHaveProperty("modelProvider");
  });

  it("does not infer native Codex auth from the profile id prefix", () => {
    const request = buildThreadStartParams(
      createAttemptParams({
        provider: "openai",
        authProfileId: "openai-codex:work",
        authProfileProvider: "openai",
      }),
      {
        cwd: "/repo",
        dynamicTools: [],
        appServer: createAppServerOptions() as never,
        developerInstructions: "test instructions",
      },
    );

    expect(request.modelProvider).toBe("openai");
  });

  it("keeps public OpenAI modelProvider when no native Codex auth profile is selected", () => {
    const request = buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
      cwd: "/repo",
      dynamicTools: [],
      appServer: createAppServerOptions() as never,
      developerInstructions: "test instructions",
    });

    expect(request.modelProvider).toBe("openai");
  });
});

describe("resolveReasoningEffort (#71946)", () => {
  describe("modern Codex models (none/low/medium/high/xhigh enum)", () => {
    it.each(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2"] as const)(
      "translates 'minimal' -> 'low' for %s so the first request is accepted",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("low");
      },
    );

    it.each(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2"] as const)(
      "passes 'low' / 'medium' / 'high' / 'xhigh' through unchanged for %s",
      (modelId) => {
        expect(resolveReasoningEffort("low", modelId)).toBe("low");
        expect(resolveReasoningEffort("medium", modelId)).toBe("medium");
        expect(resolveReasoningEffort("high", modelId)).toBe("high");
        expect(resolveReasoningEffort("xhigh", modelId)).toBe("xhigh");
      },
    );

    it("normalizes case-variant model ids", () => {
      expect(resolveReasoningEffort("minimal", "GPT-5.5")).toBe("low");
      expect(resolveReasoningEffort("minimal", " gpt-5.4-mini ")).toBe("low");
    });
  });

  describe("legacy / non-modern Codex models", () => {
    it.each(["gpt-5", "gpt-4o", "o3-mini", "codex-mini-latest"] as const)(
      "preserves 'minimal' for %s — pre-modern enum still supports it",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("minimal");
      },
    );

    it("preserves 'minimal' for empty / unknown model ids (conservative default)", () => {
      expect(resolveReasoningEffort("minimal", "")).toBe("minimal");
      expect(resolveReasoningEffort("minimal", "unknown-model-xyz")).toBe("minimal");
    });
  });

  describe("non-effort thinkLevel values", () => {
    it("returns null for 'off'", () => {
      expect(resolveReasoningEffort("off", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("off", "gpt-4o")).toBeNull();
    });

    it("returns null for 'adaptive' (non-effort enum value)", () => {
      expect(resolveReasoningEffort("adaptive", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("adaptive", "gpt-4o")).toBeNull();
    });

    it("returns null for 'max' (non-effort enum value)", () => {
      expect(resolveReasoningEffort("max", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("max", "gpt-4o")).toBeNull();
    });
  });
});
