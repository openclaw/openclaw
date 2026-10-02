import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";

const context = {
  manifestPlugins: [{ providers: ["anthropic", "openai", "openrouter"] }],
  allowPluginNormalization: false,
};

function resolveConfiguredRefForTest(cfg: OpenClawConfig) {
  return resolveConfiguredModelRef({
    ...context,
    cfg,
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
  });
}

it.each([
  {
    defaultProvider: "openai",
    raw: "openai/gpt-4o-mini",
    expected: { provider: "openai", model: "gpt-4o-mini" },
  },
  {
    defaultProvider: "anthropic",
    raw: "openai/gpt-4o-mini",
    expected: { provider: "openai", model: "gpt-4o-mini" },
  },
  {
    defaultProvider: "openai",
    raw: "anthropic/claude-sonnet-4-6",
    expected: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
])(
  "keeps explicit $raw authoritative with default provider $defaultProvider",
  ({ defaultProvider, raw, expected }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: { [`openrouter/${raw}`]: { alias: raw } },
        },
      },
    };
    const aliasIndex = buildModelAliasIndex({ ...context, cfg, defaultProvider });
    expect(
      resolveModelRefFromString({ ...context, raw, defaultProvider, aliasIndex })?.ref,
    ).toEqual(expected);
    expect(
      resolveModelRefFromString({
        ...context,
        raw: `openrouter/${raw}`,
        defaultProvider,
        aliasIndex,
      })?.ref,
    ).toEqual({ provider: "openrouter", model: raw });
  },
);

it("retains configured provider authority in an alias index used without config", () => {
  const cfg: OpenClawConfig = {
    models: { providers: { acme: { baseUrl: "https://acme.example/v1", models: [] } } },
    agents: { defaults: { models: { "openai/gpt-4o-mini": { alias: "acme/small" } } } },
  };
  const aliasIndex = buildModelAliasIndex({ ...context, cfg, defaultProvider: "openai" });
  expect(
    resolveModelRefFromString({
      ...context,
      raw: "acme/small",
      defaultProvider: "openai",
      aliasIndex,
    })?.ref,
  ).toEqual({ provider: "acme", model: "small" });
});

it("uses the supplied manifest generation to scope model aliases", () => {
  const cfg: OpenClawConfig = {
    agents: { defaults: { models: { "openai/gpt-4o-mini": { alias: "acme/small" } } } },
  };
  const aliasIndex = buildModelAliasIndex({
    ...context,
    cfg,
    defaultProvider: "openai",
    manifestPlugins: [{ providers: ["acme"] }],
  });
  expect(
    resolveModelRefFromString({
      ...context,
      raw: "acme/small",
      defaultProvider: "openai",
      aliasIndex,
    })?.ref,
  ).toEqual({ provider: "acme", model: "small" });
});

it("resolves a profile-suffixed colliding alias through its own provider", () => {
  const raw = "openai/anthropic/small@work";
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: raw,
        models: { "openai/gpt-4o-mini": { alias: "anthropic/small@work" } },
      },
    },
  };
  const aliasIndex = buildModelAliasIndex({ ...context, cfg, defaultProvider: "openai" });
  expect(
    resolveModelRefFromString({ ...context, raw, defaultProvider: "openai", aliasIndex })?.ref,
  ).toEqual({
    provider: "openai",
    model: "gpt-4o-mini",
  });
  expect(resolveConfiguredRefForTest(cfg)).toEqual({ provider: "openai", model: "gpt-4o-mini" });
});

it("keeps an explicit profile-qualified primary on its named provider", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-4o-mini@work",
        models: { "openrouter/openai/gpt-4o-mini": { alias: "openai/gpt-4o-mini" } },
      },
    },
  };
  expect(resolveConfiguredRefForTest(cfg)).toEqual({ provider: "openai", model: "gpt-4o-mini" });
});

it("resolves provider-qualified aliases without cross-provider collisions", () => {
  const index = buildModelAliasIndex({
    ...context,
    cfg: {
      agents: {
        defaults: {
          models: {
            "lmstudio-moe/qwen3.6-35b-a3b": { alias: "Local" },
            "lmstudio-dense/qwen3.6-27b": { alias: "Local" },
          },
        },
      },
    },
    defaultProvider: "openai",
  });

  expect(
    resolveModelRefFromString({
      ...context,
      raw: "lmstudio-moe/Local",
      defaultProvider: "openai",
      aliasIndex: index,
    }),
  ).toEqual({ ref: { provider: "lmstudio-moe", model: "qwen3.6-35b-a3b" }, alias: "Local" });
  expect(
    resolveModelRefFromString({
      ...context,
      raw: "lmstudio-dense/LOCAL",
      defaultProvider: "openai",
      aliasIndex: index,
    }),
  ).toEqual({ ref: { provider: "lmstudio-dense", model: "qwen3.6-27b" }, alias: "Local" });
});
