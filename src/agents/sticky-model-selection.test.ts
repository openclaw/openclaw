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
const defaultModel = model("anthropic/claude-opus-4-6");
const agentModel = model("anthropic/claude-sonnet-4-6", "google/gemini-3-pro");
function config(defaults = defaultModel, work = agentModel): OpenClawConfig {
  return { agents: { defaults: { model: defaults }, entries: { work: { model: work } } } };
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
  it.each(["defaults", "agent"] as const)(
    "persists a normalized selection at %s scope",
    async (target) => {
      mocks.cfg = config();
      expect(select("work", " openai/gpt-5.6-sol ", target)).toBe("requested");
      await vi.waitFor(() =>
        expect(mocks.info).toHaveBeenCalledWith(
          `persisted sticky model selection agentId=work model=openai/gpt-5.6-sol target=${target}`,
        ),
      );
      expect(mocks.cfg).toEqual(
        config(
          target === "defaults" ? { ...defaultModel, primary: "openai/gpt-5.6-sol" } : defaultModel,
          target === "agent" ? { ...agentModel, primary: "openai/gpt-5.6-sol" } : agentModel,
        ),
      );
    },
  );

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
