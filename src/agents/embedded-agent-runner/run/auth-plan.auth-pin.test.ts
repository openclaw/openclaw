import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OAuthCredential } from "../../auth-profiles.js";
import { testing as externalAuthTesting } from "../../auth-profiles/external-auth.test-support.js";
import {
  runWithFrontierEvidencePolicy,
  type FrontierEvidencePolicy,
} from "../../frontier-evidence-policy.js";
import { prepareAgentRuntimeAuth } from "../../runtime-plan/prepare-auth.js";
import { testing as authPlanTesting } from "./auth-plan.test-support.js";

const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null),
);

vi.mock("../../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));

describe("embedded run auth plan provider pin", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "openclaw-auth-pin-"));
    readCodexCliCredentialsCachedMock.mockReset().mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: Date.now() + 30 * 60_000,
    });
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(async () => {
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    vi.unstubAllEnvs();
    await rm(agentDir, { recursive: true, force: true });
  });

  it("keeps ambient Codex OAuth behind an OpenAI api-key pin", () => {
    const config = {
      models: {
        providers: {
          openai: { auth: "api-key", baseUrl: "", models: [] },
        },
      },
    } as OpenClawConfig;
    vi.stubEnv("OPENAI_API_KEY", "platform-api-key");

    const authProfileStore = authPlanTesting.loadEmbeddedRunAuthProfileStore({
      agentDir,
      config,
      externalCliProviderIds: ["openai"],
    });
    expect(authProfileStore.profiles["openai:default"]).toBeUndefined();
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      config,
      env: process.env,
      agentDir,
      authProfileStore,
    });

    expect(prepared.attempts[0]).toMatchObject({
      kind: "direct",
      plan: {
        selectedAuthMode: "api-key",
        modelRoute: {
          authRequirement: "api-key",
        },
      },
    });
  });

  it("locks frontier evidence auth to the admitted profile without an environment fallback", () => {
    const policy = {
      version: 1,
      policySha256: "a".repeat(64),
      configSha256: "b".repeat(64),
      defaultAgentId: "main",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      runtime: "openclaw",
      authBindingId: "c".repeat(32),
      contentDigestKey: "d".repeat(64),
      credentialState: "frozen_in_memory",
      credentialEnvName: "OPENAI_API_KEY",
      fallbacks: "disabled",
      proxy: "disabled",
      tls: "default",
      localService: "disabled",
      endpoint: {
        origin: "https://api.openai.com",
        pathname: "/v1/responses",
        method: "POST",
        transport: "responses-sdk",
      },
      thinking: "high",
      seed: "absent",
      authoredRequestParams: "absent",
      maxLogicalCalls: 64,
      expectedReasoning: { effort: "high", summary: "auto" },
      expectedInclude: ["reasoning.encrypted_content"],
      expectedMetadata: {
        source: "openai_transport_turn_state",
        keys: [
          "openclaw_session_id",
          "openclaw_transport",
          "openclaw_turn_attempt",
          "openclaw_turn_id",
        ],
        valueClass: "volatile_execution_metadata",
      },
      expectedToolChoice: "absent",
      expectedPromptCacheKey: "session_boundary",
      expectedPromptCacheRetention: "absent",
      expectedMaxRetries: 2,
    } satisfies FrontierEvidencePolicy;
    vi.stubEnv("OPENAI_API_KEY", "sk-mutated-after-admission");

    runWithFrontierEvidencePolicy(policy, "openai:matrix", () => {
      const authInputs = authPlanTesting.resolveEmbeddedRunAuthInputs({
        runParams: {
          authProfileId: undefined,
          authProfileIdSource: "auto",
        },
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const prepared = prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        config: {
          auth: {
            profiles: {
              "openai:matrix": { provider: "openai", mode: "api_key" },
            },
          },
        },
        env: authInputs.env,
        agentDir,
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:matrix": {
              type: "api_key",
              provider: "openai",
              key: "sk-admitted",
            },
          },
        },
        sessionAuthProfileId: authInputs.sessionAuthProfileId,
        sessionAuthProfileSource: authInputs.sessionAuthProfileSource,
      });

      expect(authInputs.env.OPENAI_API_KEY).toBeUndefined();
      expect(prepared.attempts).toHaveLength(1);
      expect(prepared.attempts[0]).toMatchObject({
        kind: "profile",
        profileId: "openai:matrix",
        plan: {
          forwardedAuthProfileId: "openai:matrix",
          forwardedAuthProfileSource: "user",
        },
      });
    });
  });
});
