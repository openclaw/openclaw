import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import { assertCodexModelBackedReviewerEffectiveConfig } from "./config-reviewer.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";

function openAiRuntimeOptions(
  overrides: NonNullable<Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]> = {},
) {
  return resolveCodexAppServerRuntimeOptions({
    env: {},
    requirementsToml: null,
    execMode: "auto",
    modelProvider: "openai",
    ...overrides,
  });
}

type PolicyParams = Parameters<typeof resolveCodexAppServerForModelProvider>[0];
const customEndpointConfig = {
  models: { providers: { openai: { baseUrl: "http://localhost:8080/v1", models: [] } } },
};

function reviewerForStart(start: Partial<PolicyParams["appServer"]["start"]>, env = {}) {
  const appServer = openAiRuntimeOptions({
    model: "gpt-5.5",
    pluginConfig: { appServer: { homeScope: start.homeScope } },
  });
  return resolveCodexAppServerForModelProvider({
    appServer: { ...appServer, start: { ...appServer.start, ...start } },
    provider: "openai",
    model: "gpt-5.5",
    env,
  }).approvalsReviewer;
}

const trustedConfig = { config: { model_provider: "openai" }, origins: {} };
function reviewerParams(request: ReturnType<typeof vi.fn>) {
  return {
    client: { request } as never,
    cwd: "/workspace",
    approvalsReviewer: "auto_review",
  } as const;
}

describe("Codex app-server policy", () => {
  it("revalidates effective Guardian config at each boundary and skips human reviewers", async () => {
    const request = vi.fn(async () => trustedConfig);
    const params = reviewerParams(request);

    await assertCodexModelBackedReviewerEffectiveConfig({ ...params, approvalsReviewer: "user" });
    expect(request).not.toHaveBeenCalled();
    await assertCodexModelBackedReviewerEffectiveConfig(params);
    await assertCodexModelBackedReviewerEffectiveConfig({
      ...params,
      approvalsReviewer: "guardian_subagent",
    });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects reviewer endpoint changes on the same Codex process and workspace", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(trustedConfig)
      .mockResolvedValueOnce({
        config: {
          model_provider: "openai",
          openai_base_url: "https://review-proxy.example.invalid/v1",
        },
        origins: {},
      });
    const params = reviewerParams(request);

    await assertCodexModelBackedReviewerEffectiveConfig(params);
    await expect(assertCodexModelBackedReviewerEffectiveConfig(params)).rejects.toThrow(
      /trusted OpenAI endpoint/i,
    );

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent reviewer attestations independent when one run aborts", async () => {
    const aborted = new AbortController();
    const healthy = new AbortController();
    const abortError = new Error("first run canceled");
    const request = vi.fn((_method: string, _params: unknown, options: { signal?: AbortSignal }) =>
      options.signal === aborted.signal
        ? new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(abortError), {
              once: true,
            });
          })
        : Promise.resolve(trustedConfig),
    );
    const params = reviewerParams(request);

    const first = assertCodexModelBackedReviewerEffectiveConfig({
      ...params,
      signal: aborted.signal,
    });
    const second = assertCodexModelBackedReviewerEffectiveConfig({
      ...params,
      signal: healthy.signal,
    });
    expect(request).toHaveBeenCalledTimes(2);
    const canceled = expect(first).rejects.toBe(abortError);
    aborted.abort(abortError);
    await Promise.all([
      canceled,
      expect(second).resolves.toMatchObject({ config: { model_provider: "openai" } }),
    ]);
  });

  it("revalidates Guardian trust across calls and workspaces on one Codex process", async () => {
    const request = vi.fn(async (_method: string, params: { cwd?: string }) => ({
      config:
        params.cwd === "/workspace/trusted"
          ? { model_provider: "openai" }
          : {
              model_provider: "openai",
              openai_base_url: "https://review-proxy.example.invalid/v1",
            },
      origins: {},
    }));
    const client = { request };

    await assertCodexModelBackedReviewerEffectiveConfig({
      client: client as never,
      approvalsReviewer: "auto_review",
      cwd: "/workspace/trusted",
    });
    await assertCodexModelBackedReviewerEffectiveConfig({
      client: client as never,
      approvalsReviewer: "guardian_subagent",
      cwd: "/workspace/trusted/.",
    });
    expect(request).toHaveBeenCalledTimes(2);

    await expect(
      assertCodexModelBackedReviewerEffectiveConfig({
        client: client as never,
        approvalsReviewer: "auto_review",
        cwd: "/workspace/untrusted",
      }),
    ).rejects.toThrow(/trusted OpenAI endpoint/i);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing effective config", undefined, /invalid effective config/i],
    ["alternate model provider", { model_provider: "custom" }, /reviewer/i],
    [
      "managed ChatGPT endpoint",
      { chatgpt_base_url: "https://review-proxy.example.invalid" },
      /reviewer/i,
    ],
    [
      "managed model-provider endpoint",
      {
        model_providers: { openai: { base_url: "https://proxy.example.invalid/v1" } },
      },
      /reviewer/i,
    ],
  ] as const)("fails Guardian review closed on %s", async (_name, config, error) => {
    const request = vi.fn(async () => (config ? { config } : {}));
    await expect(
      assertCodexModelBackedReviewerEffectiveConfig(reviewerParams(request)),
    ).rejects.toThrow(error);
  });

  it("uses human approval for OpenAI-compatible custom endpoints", () => {
    const appServer = openAiRuntimeOptions({
      model: "gpt-5.5",
      config: customEndpointConfig,
    });

    expect(appServer.approvalsReviewer).toBe("user");
    expect(
      resolveCodexAppServerForModelProvider({
        appServer,
        provider: "openai",
        model: "gpt-5.5",
        config: customEndpointConfig,
      }).approvalsReviewer,
    ).toBe("user");
  });

  it("uses human approval instead of Codex Guardian for custom model providers", () => {
    const appServer = openAiRuntimeOptions();

    const resolved = resolveCodexAppServerForModelProvider({
      appServer,
      provider: "lmstudio",
    });
    const vendorPrefixedModel = resolveCodexAppServerForModelProvider({
      appServer,
      provider: "openrouter",
      model: "openai/gpt-5.5",
    });

    expect(appServer.approvalsReviewer).toBe("auto_review");
    expect(resolved).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    expect(vendorPrefixedModel.approvalsReviewer).toBe("user");
  });

  it.each([
    {
      name: "provider-qualified model in a native wrapper",
      provider: "codex",
      model: "lmstudio/local-model",
      options: { execMode: "auto" },
    },
    {
      name: "legacy guardian_subagent",
      provider: "local",
      model: undefined,
      options: {
        pluginConfig: { appServer: { mode: "guardian", approvalsReviewer: "guardian_subagent" } },
      },
    },
  ] as const)("uses human approval for $name", ({ provider, model, options }) => {
    const appServer = resolveCodexAppServerRuntimeOptions({
      env: {},
      requirementsToml: null,
      ...options,
    });
    expect(
      resolveCodexAppServerForModelProvider({ appServer, provider, model }).approvalsReviewer,
    ).toBe("user");
  });

  it("checks the actual app-server home instead of the caller's ambient Codex home", async () => {
    await withTempDir("openclaw-codex-review-home-", async (root) => {
      const ambientHome = path.join(root, "ambient");
      const effectiveHome = path.join(root, "effective");
      await Promise.all(
        [ambientHome, effectiveHome].map((dir) => fs.mkdir(dir, { recursive: true })),
      );
      await fs.writeFile(
        path.join(effectiveHome, "config.toml"),
        'openai_base_url = "http://localhost:8080/v1"\n',
      );
      expect(
        reviewerForStart(
          { homeScope: "user", env: { CODEX_HOME: effectiveHome } },
          { CODEX_HOME: ambientHome },
        ),
      ).toBe("user");
    });
  });

  it("checks endpoint overrides applied to the actual app-server process", () => {
    expect(reviewerForStart({ env: { OPENAI_BASE_URL: "http://localhost:8080/v1" } })).toBe("user");
  });

  it.each([["-pwork"]])(
    "checks the selected native profile before trusting model-backed review: %j",
    async (...profileArgs) => {
      await withTempDir("openclaw-codex-review-profile-", async (codexHome) => {
        await fs.writeFile(
          path.join(codexHome, "work.config.toml"),
          'openai_base_url = "http://localhost:8080/v1"\n',
        );
        expect(
          reviewerForStart({
            homeScope: "user",
            args: [...profileArgs, "app-server"],
            env: { CODEX_HOME: codexHome },
          }),
        ).toBe("user");
      });
    },
  );

  it.each(["model_providers.openai.base_url=https://api.openai.com/v1"])(
    "keeps automatic review for native CLI string override: %s",
    (override) => {
      expect(reviewerForStart({ args: ["app-server", "-c", override] })).toBe("auto_review");
    },
  );

  it.each([
    ["-c", "\u0085openai_base_url=http://localhost:8080/v1"],
    ['-c=chatgpt_base_url="http://localhost:8080/v1"'],
    ['-cmodel_providers.openai.base_url="http://localhost:8080/v1"'],
    [
      '-copenai_base_url="http://localhost:8080/v1"',
      '-copenai_base_url="https://api.openai.com/v1"',
    ],
  ])(
    "checks native command-line endpoint overrides before trusting model-backed review: %j",
    (...args) => {
      expect(reviewerForStart({ args: ["app-server", ...args] })).toBe("user");
    },
  );
});
