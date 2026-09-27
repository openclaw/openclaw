import { describe, expect, it } from "vitest";
import {
  resolveProjectedSessionContextTokens,
  resolveTrustedSessionContextTokens,
} from "../config/sessions/context-token-provenance.js";
import { resolveOuterContextTokenMeta } from "./embedded-agent-runner/run/context-token-meta.js";
import { createSessionContextCapacityResolver } from "./session-context-capacity.js";

const selection = {
  provider: "github-copilot",
  model: "claude-opus-5.5",
  agentHarnessId: "openclaw",
};
const persisted = (contextTokensSource: "synthetic" | "runtime") => ({
  modelProvider: "github-copilot",
  model: "claude-opus-5.5",
  agentHarnessId: "openclaw",
  contextTokens: 128_000,
  contextTokensSource,
});
const accepted = {
  provider: "github-copilot",
  id: "claude-opus-5.5",
  name: "Claude Opus 5.5",
  api: "anthropic-messages" as const,
  contextWindow: 1_000_000,
  contextTokens: 872_000,
};
const syntheticRow = {
  ...accepted,
  contextWindow: 128_000,
  contextTokens: undefined,
  contextWindowSource: "synthetic" as const,
};
function owner(entries: object[], current = true) {
  let isCurrent = current;
  return {
    retire: () => {
      isCurrent = false;
    },
    snapshot: {
      isCurrent: () => isCurrent,
      modelCatalog: { entries: [] },
      readFullModelCatalog: () => ({ entries: entries as never[] }),
    },
  };
}

describe("synthetic producer provenance", () => {
  it("stamps a budget that is exactly the provider estimate", () => {
    expect(
      resolveOuterContextTokenMeta(syntheticRow, {
        contextTokenBudget: 128_000,
        contextWindowInfo: { tokens: 128_000, source: "model" },
      }),
    ).toEqual({ contextTokens: 128_000, contextTokensSource: "synthetic" });
  });
  it.each([
    ["reported window", { ...syntheticRow, contextWindowSource: undefined }, {}],
    ["reported prompt limit", { ...syntheticRow, contextTokens: 128_000 }, {}],
    ["authored cap", syntheticRow, { authoredContextTokenCap: 128_000 }],
    ["modelsConfig sizing", syntheticRow, { source: "modelsConfig" }],
    ["narrower caller budget", syntheticRow, { contextTokenBudget: 64_000 }],
  ])("does not stamp a %s", (_name, model, patch: Record<string, unknown>) => {
    const meta = resolveOuterContextTokenMeta(model, {
      contextTokenBudget: 128_000,
      contextWindowInfo: { tokens: 128_000, source: (patch.source as string) ?? "model" },
      ...patch,
    });
    expect(meta.contextTokensSource).toBeUndefined();
  });
});

describe("existing-session recovery through the admitted owner", () => {
  it("a synthetic persisted 128k is never trusted telemetry, even for a locked session", () => {
    const entry = persisted("synthetic");
    expect(resolveTrustedSessionContextTokens({ entry, ...selection })).toBeUndefined();
    expect(
      resolveTrustedSessionContextTokens({
        entry: { ...entry, modelSelectionLocked: true },
        ...selection,
      }),
    ).toBeUndefined();
  });

  it("recovers to the owner's accepted discovered limit on the next status", () => {
    const resolve = createSessionContextCapacityResolver(owner([accepted]).snapshot);
    const ownerCapacity = resolve("github-copilot", "claude-opus-5.5");
    expect(ownerCapacity).toEqual({ state: "ready", contextTokens: 872_000, synthetic: false });
    expect(
      resolveProjectedSessionContextTokens({
        entry: persisted("synthetic"),
        ...selection,
        // Even a stale cache answer cannot pin the old estimate.
        resolvedContextTokens: 128_000,
        ownerCapacity,
      }),
    ).toBe(872_000);
  });

  it("keeps genuine (non-synthetic) persisted 128k conservative", () => {
    const ownerCapacity = createSessionContextCapacityResolver(owner([accepted]).snapshot)(
      "github-copilot",
      "claude-opus-5.5",
    );
    expect(
      resolveProjectedSessionContextTokens({
        entry: persisted("runtime"),
        ...selection,
        resolvedContextTokens: 872_000,
        ownerCapacity,
      }),
    ).toBe(128_000);
  });

  it("keeps an authored cap below the owner's accepted limit", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: persisted("synthetic"),
        ...selection,
        resolvedContextTokens: 872_000,
        authoredContextTokens: 64_000,
        ownerCapacity: { state: "ready", contextTokens: 872_000, synthetic: false },
      }),
    ).toBe(64_000);
  });

  it.each([
    ["unbound (no owner)", undefined],
    [
      "retired owner",
      (() => {
        const o = owner([accepted]);
        o.retire();
        return o.snapshot;
      })(),
    ],
    [
      "failed preparation (read throws)",
      {
        isCurrent: () => true,
        modelCatalog: { entries: [] },
        readFullModelCatalog: () => {
          throw new Error("prepared runtime cancelled");
        },
      },
    ],
    [
      "owner retired during the read",
      (() => {
        const o = owner([accepted]);
        const read = o.snapshot.readFullModelCatalog;
        o.snapshot.readFullModelCatalog = () => {
          o.retire();
          return read();
        };
        return o.snapshot;
      })(),
    ],
    ["owner without the model", owner([]).snapshot],
  ])("settles %s as owner-scoped unknown, not stale 128k", (_name, snapshot) => {
    const ownerCapacity = createSessionContextCapacityResolver(snapshot)(
      "github-copilot",
      "claude-opus-5.5",
    );
    expect(ownerCapacity).toEqual({ state: "unavailable" });
    expect(
      resolveProjectedSessionContextTokens({
        entry: persisted("synthetic"),
        ...selection,
        // A process-global cache answer from another owner must not be borrowed.
        resolvedContextTokens: 872_000,
        ownerCapacity,
      }),
    ).toBeUndefined();
  });

  it("another owner's accepted inventory does not answer for this session", () => {
    const otherAccount = owner([accepted]);
    const thisOwner = owner([syntheticRow]);
    // Two independent resolvers: each only reads its own bound owner.
    expect(
      createSessionContextCapacityResolver(otherAccount.snapshot)(
        "github-copilot",
        "claude-opus-5.5",
      ),
    ).toMatchObject({ contextTokens: 872_000 });
    expect(
      createSessionContextCapacityResolver(thisOwner.snapshot)("github-copilot", "claude-opus-5.5"),
    ).toEqual({ state: "ready", contextTokens: 128_000, synthetic: true });
    // Retiring this owner does not let the other owner fill in, and vice versa.
    thisOwner.retire();
    expect(
      createSessionContextCapacityResolver(thisOwner.snapshot)("github-copilot", "claude-opus-5.5"),
    ).toEqual({ state: "unavailable" });
    expect(
      createSessionContextCapacityResolver(otherAccount.snapshot)(
        "github-copilot",
        "claude-opus-5.5",
      ),
    ).toMatchObject({ state: "ready", contextTokens: 872_000 });
  });

  it("a real prompt limit beside an estimated native window is reported capacity", () => {
    expect(
      createSessionContextCapacityResolver(
        owner([{ ...syntheticRow, contextWindow: 777_000, contextTokens: 777_000 }]).snapshot,
      )("github-copilot", "claude-opus-5.5"),
    ).toEqual({ state: "ready", contextTokens: 777_000, synthetic: false });
  });

  it("without an owner binding the legacy projection is unchanged", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: persisted("runtime"),
        ...selection,
        resolvedContextTokens: 872_000,
      }),
    ).toBe(128_000);
  });
});
