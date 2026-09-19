import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import { authStore, routeResolverFactory } from "./model-auth-availability.test-support.js";

describe("strict CLI backend session account selection", () => {
  // claude-cli declares strictSelectedProfile: a selected account is an account
  // boundary. An automatic session preference is a preference, not a selection.
  const claudeCliConfig: OpenClawConfig = {
    agents: {
      defaults: {
        models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
      },
    },
  };
  const cliStore = authStore({
    "openai:auto": {
      type: "oauth",
      provider: "openai",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 600_000,
    },
  });
  const evaluateClaudeCli = (ref: { preferredProfileId?: string; pinnedProfileId?: string }) =>
    createModelAuthAvailabilityResolver({
      cfg: claudeCliConfig,
      authStore: cliStore,
      env: {},
      allowPreparedRuntimeAuth: false,
      preparedRuntimeAuthModes: { "claude-cli": "oauth" },
      preparedSyntheticAuthComplete: true,
      routeResolverFactory: routeResolverFactory(null),
    }).evaluateRuntimeModelAuth("anthropic", {
      modelId: "claude-opus-5",
      runtimeId: "claude-cli",
      ...ref,
    });

  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("keeps the native CLI route available for an automatic session account", () => {
    // The account resolver persisted an OpenAI account for this session; that
    // preference must not be read as a strict selected profile for claude-cli.
    expect(evaluateClaudeCli({ preferredProfileId: "openai:auto" })).toMatchObject({
      availability: true,
      evidence: "runtime",
      selectedAuthMode: "oauth",
    });
  });

  it("still refuses to rescue a pinned account the strict CLI cannot execute", () => {
    const pinned = evaluateClaudeCli({
      preferredProfileId: "openai:auto",
      pinnedProfileId: "openai:auto",
    });
    expect(pinned.availability).not.toBe(true);
  });
});
