import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  resolveImageFallbackCandidates,
  resolveModelCandidateChain,
} from "./model-fallback-candidates.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const customProvider: ModelProviderConfig = {
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  models: ["model", "custom/model"].map((id) =>
    makeProviderModelFixture({
      id,
      provider: "custom",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
    }),
  ),
};

describe("resolveModelCandidateChain", () => {
  it.each([
    { origin: "requested", primary: "custom/model", model: "custom/model", first: "custom/model" },
    { origin: "configured-fallback", primary: "custom/model", model: "model", first: "model" },
    {
      origin: "configured-primary",
      primary: "custom/custom/model",
      model: "model",
      first: "model",
    },
  ] as const)(
    "preserves literal model namespaces from $origin",
    ({ origin, primary, model, first }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary,
              fallbacks:
                origin === "configured-primary"
                  ? []
                  : ["custom/custom/model", "custom/model", "custom/custom/model"],
            },
          },
        },
        models: {
          providers: {
            custom: customProvider,
          },
        },
      };

      expect(
        resolveModelCandidateChain({
          cfg,
          provider: " Custom ",
          model,
          requestedRouteResolution: "resolved",
          manifestPlugins: [],
        }),
      ).toEqual([
        { provider: "custom", model: first, routeOrigin: "requested", routeResolution: "resolved" },
        {
          provider: "custom",
          model: first === "model" ? "custom/model" : "model",
          routeOrigin: origin === "configured-primary" ? origin : "configured-fallback",
          routeResolution: "resolved",
        },
      ]);
    },
  );

  it.each([
    { source: "raw", model: "latest", inputResolution: "raw", origin: "requested" },
    { source: "resolved", model: "release", inputResolution: "resolved", origin: "requested" },
    {
      source: "provider prefix",
      model: "candidate/latest",
      inputResolution: "raw",
      origin: "requested",
    },
    { source: "config alias", model: "shortcut", inputResolution: "raw", origin: "requested" },
    {
      source: "configured-fallback",
      model: "unrelated",
      inputResolution: "resolved",
      origin: "configured-fallback",
    },
    {
      source: "configured-primary",
      model: "unrelated",
      inputResolution: "resolved",
      origin: "configured-primary",
    },
  ] as const)(
    "preserves the resolved $source output when reused as input",
    ({ source, model, inputResolution, origin }) => {
      const primary = origin === "configured-primary" ? "latest" : "unrelated";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: `candidate/${primary}`,
              fallbacks: origin === "configured-fallback" ? ["candidate/latest"] : [],
            },
            ...(source === "config alias"
              ? { models: { "candidate/latest": { alias: "shortcut" } } }
              : {}),
          },
        },
      };
      const manifestPlugins = [
        {
          modelIdNormalization: {
            providers: { candidate: { aliases: { latest: "release", release: "stable" } } },
          },
        },
      ];
      const candidates = resolveModelCandidateChain({
        cfg,
        provider: "candidate",
        model,
        requestedRouteResolution: inputResolution,
        manifestPlugins,
      });
      const selected = candidates.find((candidate) => candidate.routeOrigin === origin);
      expect(selected).toMatchObject({
        provider: "candidate",
        model: "release",
        routeOrigin: origin,
      });
      expect(candidates.some(({ model: candidateModel }) => candidateModel === "stable")).toBe(
        false,
      );
      if (!selected) {
        throw new Error("Expected selected candidate");
      }
      expect(
        resolveModelCandidateChain({
          cfg,
          provider: selected.provider,
          model: selected.model,
          requestedRouteResolution: selected.routeResolution,
          fallbacksOverride: [],
          manifestPlugins,
        }),
      ).toEqual([
        {
          provider: "candidate",
          model: "release",
          routeOrigin: "requested",
          routeResolution: "resolved",
        },
      ]);
    },
  );
});

describe("resolveImageFallbackCandidates", () => {
  it("keeps distinct literal model namespaces while removing duplicate routes", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          imageModel: {
            primary: "custom/model",
            fallbacks: ["custom/custom/model", "custom/model", "custom/custom/model"],
          },
        },
      },
      models: {
        providers: {
          custom: customProvider,
        },
      },
    };
    expect(
      resolveImageFallbackCandidates({ cfg, defaultProvider: "custom", manifestPlugins: [] }),
    ).toEqual([
      {
        provider: "custom",
        model: "model",
        routeOrigin: "configured-primary",
        routeResolution: "resolved",
      },
      {
        provider: "custom",
        model: "custom/model",
        routeOrigin: "configured-fallback",
        routeResolution: "resolved",
      },
    ]);
  });

  it("records unresolved configured entries without changing the resolved chain", async () => {
    const warnLogs = createWarnLogCapture("openclaw-image-fallback-candidates-test");
    const cfg = {
      agents: {
        defaults: {
          imageModel: {
            primary: "openai/",
            fallbacks: ["anthropic/claude-sonnet-4-6", "/vision"],
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveImageFallbackCandidates({
          cfg,
          defaultProvider: "openai",
        }),
      ).toEqual([
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          routeOrigin: "configured-fallback",
          routeResolution: "resolved",
        },
      ]);
      expect(
        await warnLogs.findText(
          'Unresolved image model "openai/"; skipped configured-primary candidate.',
        ),
      ).toBeDefined();
      expect(
        await warnLogs.findText(
          'Unresolved image model "/vision"; skipped configured-fallback candidate.',
        ),
      ).toBeDefined();
    } finally {
      warnLogs.cleanup();
    }
  });

  it("does not warn for resolved configured entries", async () => {
    const warnLogs = createWarnLogCapture("openclaw-image-fallback-candidates-test");
    const cfg = {
      agents: {
        defaults: {
          imageModel: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveImageFallbackCandidates({
          cfg,
          defaultProvider: "openai",
        }),
      ).toHaveLength(2);
      expect(await warnLogs.findText("Unresolved image model")).toBeUndefined();
    } finally {
      warnLogs.cleanup();
    }
  });
});
