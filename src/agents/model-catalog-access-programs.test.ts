import { expect, it, vi } from "vitest";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  projectModelCatalogAccessPrograms,
  resolveCyberAccessProgramForProvider,
  resolveModelCatalogAccessPrograms,
  resolveTurnCyberAccessProgram,
} from "./model-catalog-access-programs.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

const route = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;
const entry = { provider: "openai", id: "synthetic-model" };
const observation = {
  modelId: entry.id,
  runtimeId: "openclaw",
  ...route,
  cyber: ["standard", "daybreak_blue"] as const,
};
const outcome = {
  provider: "openai",
  profileId: "openai:a",
  status: "ready" as const,
  modelAccessPrograms: [observation],
};
const snapshot: ModelCatalogSnapshot = {
  entries: [],
  routeVariants: [],
  providerOutcomes: [outcome],
};
const evaluation: ModelAuthAvailabilityEvaluation = {
  availability: true,
  routeResolution: null,
  selectedRoute: route,
  selectedCredential: { source: "profile", profileId: "openai:a", identityKey: "profile:a" },
};
const resolve = (changes: Partial<Parameters<typeof resolveModelCatalogAccessPrograms>[0]> = {}) =>
  resolveModelCatalogAccessPrograms({
    snapshot,
    entry,
    evaluation,
    runtimeId: "openclaw",
    isCurrent: () => true,
    ...changes,
  });

it("never reuses program entitlement across accounts, models, runtimes, routes or refreshes", () => {
  expect(resolve()).toEqual(["standard", "daybreak_blue"]);
  for (const changes of [
    { runtimeId: "codex" },
    { entry: { ...entry, id: "other" } },
    {
      evaluation: {
        ...evaluation,
        selectedCredential: {
          source: "profile" as const,
          profileId: "openai:b",
          identityKey: "profile:b",
        },
      },
    },
    {
      evaluation: {
        ...evaluation,
        selectedRoute: { ...route, baseUrl: "https://other.example/v1" },
      },
    },
    { evaluation: { ...evaluation, availability: undefined } },
    { isCurrent: () => false },
    { snapshot: { ...snapshot, refreshFailed: true } },
    { snapshot: { ...snapshot, pendingProviders: ["openai"] } },
    {
      snapshot: { ...snapshot, providerOutcomes: [{ ...outcome, status: "unavailable" as const }] },
    },
  ]) {
    expect(resolve(changes)).toBeUndefined();
  }
  expect(
    resolve({
      snapshot: {
        ...snapshot,
        providerOutcomes: [{ ...outcome, modelAccessPrograms: [{ ...observation, cyber: [] }] }],
      },
    }),
  ).toEqual([]);
});

it("uses native-owned observations only while native account ownership is current", () => {
  const nativeSnapshot = {
    ...snapshot,
    nativeProviderOutcomes: {
      codex: [
        {
          ...outcome,
          profileId: undefined,
          modelAccessPrograms: [
            { modelId: entry.id, runtimeId: "codex", cyber: ["daybreak_red"] as const },
          ],
        },
      ],
    },
  };
  const nativeEvaluation = {
    ...evaluation,
    selectedCredential: { source: "harness" as const },
    runtimeAuth: { id: "codex", source: "native" as const },
  };
  expect(
    resolve({ snapshot: nativeSnapshot, evaluation: nativeEvaluation, runtimeId: "codex" }),
  ).toEqual(["daybreak_red"]);
  expect(resolve({ snapshot: nativeSnapshot, runtimeId: "codex" })).toBeUndefined();
  expect(
    resolve({
      snapshot: nativeSnapshot,
      evaluation: { ...nativeEvaluation, runtimeAuth: undefined },
      runtimeId: "codex",
    }),
  ).toBeUndefined();
});

it.each(["openclaw", "codex"])(
  "publishes a Standard baseline without Daybreak entitlement for %s",
  (runtimeId) => {
    const params = {
      snapshot: { ...snapshot, providerOutcomes: [] },
      entry,
      evaluation,
      runtimeId,
      isCurrent: () => true,
    };
    expect(projectModelCatalogAccessPrograms({ ...params, config: {} })).toEqual({
      cyberAccessProgramDefault: "standard",
    });
    expect(
      projectModelCatalogAccessPrograms({
        ...params,
        config: {
          agents: { defaults: { params: { accessPrograms: { cyber: "daybreak_blue" } } } },
        },
      }),
    ).toEqual({ cyberAccessProgramDefault: "daybreak_blue" });
    expect(
      projectModelCatalogAccessPrograms({
        ...params,
        entry: { ...entry, provider: "other" },
        config: {},
      }),
    ).toEqual({});
    expect(
      projectModelCatalogAccessPrograms({
        ...params,
        config: { agents: { defaults: { params: { accessPrograms: {} } } } },
      }),
    ).toEqual({});
  },
);

it("applies a saved Daybreak choice only to OpenAI turns", () => {
  expect(resolveCyberAccessProgramForProvider("daybreak_blue", "anthropic")).toEqual({
    program: "standard",
    notApplied: "daybreak_blue",
  });
  expect(resolveCyberAccessProgramForProvider("daybreak_red", "claude-cli")).toEqual({
    program: "standard",
    notApplied: "daybreak_red",
  });
  expect(resolveCyberAccessProgramForProvider("daybreak_blue", "OpenAI")).toEqual({
    program: "daybreak_blue",
  });
  // Codex CLI is still an OpenAI model; its runtime keeps the explicit unsupported error.
  expect(resolveCyberAccessProgramForProvider("daybreak_blue", "codex-cli")).toEqual({
    program: "daybreak_blue",
  });
  expect(resolveCyberAccessProgramForProvider("standard", "anthropic")).toEqual({
    program: "standard",
  });
  expect(resolveCyberAccessProgramForProvider(undefined, "anthropic")).toEqual({
    program: undefined,
  });
});

it("notifies a non-OpenAI Access downgrade once per scope and model", () => {
  const notify = vi.fn();
  const scope = `test:${Math.random()}`;
  const turn = (provider: string, model: string) =>
    resolveTurnCyberAccessProgram({
      program: "daybreak_blue",
      provider,
      model,
      noticeScope: scope,
      notify,
    });
  expect(turn("anthropic", "claude-opus-5-5")).toBe("standard");
  expect(turn("anthropic", "claude-opus-5-5")).toBe("standard");
  expect(turn("openai", "gpt-6.1-sol")).toBe("daybreak_blue");
  expect(notify).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(
    "Daybreak Blue applies only to OpenAI models, so anthropic/claude-opus-5-5 used Standard access. Your Daybreak Blue choice is kept for when this chat returns to an OpenAI model.",
  );
});
