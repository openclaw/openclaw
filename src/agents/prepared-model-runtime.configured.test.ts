import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectPreparedModelRuntimeProviderIds,
} from "./prepared-model-runtime.configured.js";

describe("configured runtime provider discovery", () => {
  it.each([undefined, "worker"])(
    "includes literal session selections in provider preparation (agent: %s)",
    (agentId) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "other/default",
            models: {
              "fixture/Reader": { agentRuntime: { id: "openclaw" } },
              "fixture/Reader@variant": { agentRuntime: { id: "fixture-harness" } },
            },
          },
        },
      };
      const before = structuredClone(config);
      const selections = Object.freeze([
        Object.freeze({ provider: "fixture", modelId: "Reader@variant" }),
        Object.freeze({ provider: "fixture", modelId: "reader@variant" }),
      ]);
      const configured = collectPreparedModelRuntimeConfiguredRefs(config, agentId);
      const refs = collectPreparedModelRuntimeConfiguredRefs(config, agentId, selections);

      expect(refs.slice(0, configured.length)).toEqual(configured);
      expect(refs.slice(configured.length).map(({ value, kind }) => ({ value, kind }))).toEqual([
        { value: "fixture/Reader@variant", kind: "literal" },
        { value: "fixture/reader@variant", kind: "literal" },
      ]);
      expect(
        collectPreparedModelRuntimeProviderIds(
          config,
          {},
          false,
          refs.slice(configured.length),
          agentId,
        ),
      ).toEqual(["fixture", "fixture-harness"]);
      expect(config).toEqual(before);
    },
  );

  it.each(["defaults", "agent"] as const)(
    "preserves literal model-map IDs in %s scope",
    (scope) => {
      const models = {
        "fixture/reader": { agentRuntime: { id: "openclaw" } },
        "fixture/reader@variant": { agentRuntime: { id: "codex" } },
      };
      const config: OpenClawConfig = {
        agents:
          scope === "defaults" ? { defaults: { models } } : { entries: { worker: { models } } },
      };

      expect(
        collectPreparedModelRuntimeProviderIds(
          config,
          {},
          false,
          undefined,
          scope === "agent" ? "worker" : undefined,
        ),
      ).toEqual(["codex", "fixture"]);
    },
  );

  it.each<{ name: string; config: OpenClawConfig }>([
    {
      name: "voice model fallbacks",
      config: {
        agents: {
          defaults: {
            voiceModel: { primary: "fixture/reader", fallbacks: ["fixture/reader@variant"] },
          },
        },
      },
    },
    {
      name: "media generation fallbacks",
      config: {
        agents: {
          defaults: {
            mediaModels: {
              image: { primary: "fixture/reader", fallbacks: ["fixture/reader@variant"] },
            },
          },
        },
      },
    },
    {
      name: "media understanding preferences",
      config: { tools: { media: { image: { preferredModel: "fixture/reader@variant" } } } },
    },
  ])("preserves literal IDs in $name", ({ config }) => {
    config.models = {
      providers: {
        fixture: {
          baseUrl: "https://fixture.invalid/v1",
          models: ["reader", "reader@variant"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            contextWindow: 32000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            agentRuntime: { id: id === "reader" ? "openclaw" : "fixture-harness" },
          })),
        },
      },
    };

    expect(collectPreparedModelRuntimeProviderIds(config, {}, false)).toEqual([
      "fixture",
      "fixture-harness",
    ]);
  });
});
