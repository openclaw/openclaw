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

it.each(["config", "manifest"])(
  "retains %s provider authority in a config-free index",
  (source) => {
    const cfg: OpenClawConfig = {
      ...(source === "config"
        ? { models: { providers: { acme: { baseUrl: "https://acme.example/v1", models: [] } } } }
        : {}),
      agents: { defaults: { models: { "openai/gpt-4o-mini": { alias: "acme/small" } } } },
    };
    const aliasIndex = buildModelAliasIndex({
      ...context,
      cfg,
      defaultProvider: "openai",
      manifestPlugins: source === "manifest" ? [{ providers: ["acme"] }] : context.manifestPlugins,
    });
    expect(
      resolveModelRefFromString({
        ...context,
        raw: "acme/small",
        defaultProvider: "openai",
        aliasIndex,
      })?.ref,
    ).toEqual({ provider: "acme", model: "small" });
  },
);

it.each([
  {
    raw: "openai/anthropic/small@work",
    target: "openai/gpt-4o-mini",
    alias: "anthropic/small@work",
  },
  {
    raw: "openai/gpt-4o-mini@work",
    target: "openrouter/openai/gpt-4o-mini",
    alias: "openai/gpt-4o-mini",
  },
])("resolves profile-qualified primary $raw in its own provider", ({ raw, target, alias }) => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: raw,
        models: { [target]: { alias } },
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
