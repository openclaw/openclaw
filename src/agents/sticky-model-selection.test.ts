import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  info: vi.fn(),
  isConfigReadOnly: false,
  isNixMode: false,
  mutateConfigFileWithRetry: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: mocks.info, warn: mocks.warn }),
}));

vi.mock("../config/paths.js", () => ({
  resolveIsConfigReadOnly: () => mocks.isConfigReadOnly,
  resolveIsNixMode: () => mocks.isNixMode,
}));

import { persistStickyModelSelectionBestEffort } from "./sticky-model-selection.js";

const model = (primary: string, fallback = "openai/gpt-5.6-luna") => ({
  primary,
  fallbacks: [fallback],
});
function config(
  defaultModel: string | ReturnType<typeof model>,
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return { agents: { defaults: { model: defaultModel }, entries } };
}
function select(
  agentId = "main",
  selectedModel = "openai/gpt-5.6-sol",
  target: "agent" | "defaults" = "defaults",
) {
  return persistStickyModelSelectionBestEffort({ agentId, model: selectedModel, target });
}

beforeEach(() => {
  mocks.info.mockReset();
  mocks.warn.mockReset();
  mocks.isConfigReadOnly = false;
  mocks.isNixMode = false;
  mocks.mutateConfigFileWithRetry.mockReset().mockImplementation(async ({ mutate }) => {
    const draft = structuredClone(mocks.cfg);
    const result = await mutate(draft, {});
    mocks.cfg = draft;
    return { nextConfig: draft, result };
  });
});

describe("persistStickyModelSelection", () => {
  it.each<[string, "agent" | "defaults", OpenClawConfig]>([
    [
      "work",
      "agent",
      config("anthropic/claude-opus-4-6", {
        main: {},
        work: { model: model("anthropic/claude-sonnet-4-6") },
      }),
    ],
    ["main", "agent", config(model("anthropic/claude-opus-4-6"), { main: {} })],
    [
      "work",
      "defaults",
      config(model("anthropic/claude-opus-4-6"), {
        work: { model: model("anthropic/claude-sonnet-4-6", "google/gemini-3-pro") },
      }),
    ],
  ])("writes %s at %s scope", async (agentId, target, cfg) => {
    mocks.cfg = structuredClone(cfg);

    expect(select(agentId, " openai/gpt-5.6-sol ", target)).toBe("requested");
    await vi.waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(
        `persisted sticky model selection agentId=${agentId} model=openai/gpt-5.6-sol target=${target}`,
      ),
    );

    const persistedPrimary =
      target === "defaults"
        ? mocks.cfg.agents?.defaults?.model
        : mocks.cfg.agents?.entries?.[agentId]?.model;
    if (target === "agent" && agentId === "main") {
      expect(persistedPrimary).toBe("openai/gpt-5.6-sol");
      return;
    }
    expect(persistedPrimary).toMatchObject(model("openai/gpt-5.6-sol"));
  });

  it("rejects an empty model before starting a config mutation", async () => {
    expect(select("main", "   ")).toBe("requested");

    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        "failed sticky model persistence agentId=main model=    reason=Sticky model selection must be non-empty.",
      ),
    );
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("warns and absorbs asynchronous config write failures", async () => {
    mocks.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error("config is read-only"));

    expect(select()).toBe("requested");

    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        "failed sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config is read-only",
      ),
    );
  });

  it("skips Nix immutable config and warns only once per process", () => {
    mocks.isConfigReadOnly = true;
    mocks.isNixMode = true;

    expect(select()).toBe("skipped-immutable");
    expect(select("work", "openai/gpt-5.6-luna", "agent")).toBe("skipped-immutable");

    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      "skipped sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config is immutable in OPENCLAW_NIX_MODE",
    );
  });
});
