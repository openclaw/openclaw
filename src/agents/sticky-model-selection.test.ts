import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  isConfigReadOnly: false,
  isNixMode: false,
  mutateConfigFileWithRetry: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: mocks.warn }),
}));

vi.mock("../config/paths.js", () => ({
  resolveIsConfigReadOnly: () => mocks.isConfigReadOnly,
  resolveIsNixMode: () => mocks.isNixMode,
}));

import { persistStickyModelSelectionBestEffort } from "./sticky-model-selection.js";

const defaultModel = { primary: "provider/default", fallbacks: ["provider/fallback"] };
const agentModel = { primary: "provider/agent", fallbacks: ["provider/other"] };
const selected = "provider/new";
function config(defaults = defaultModel, work = agentModel): OpenClawConfig {
  return { agents: { defaults: { model: defaults }, entries: { work: { model: work } } } };
}
const select = (target: "agent" | "defaults" = "defaults", model = selected, agentId = "main") =>
  persistStickyModelSelectionBestEffort({ agentId, model, target });
const expectWarning = (reason: string) =>
  vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(reason)));

beforeEach(() => {
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

it.each(["defaults", "agent"] as const)(
  "persists a normalized selection at %s scope",
  async (target) => {
    mocks.cfg = config();
    expect(select(target, ` ${selected} `, "work")).toBe("requested");
    await vi.waitFor(() =>
      expect(mocks.cfg).toEqual(
        config(
          target === "defaults" ? { ...defaultModel, primary: selected } : defaultModel,
          target === "agent" ? { ...agentModel, primary: selected } : agentModel,
        ),
      ),
    );
  },
);

it("rejects an empty model before starting a config mutation", async () => {
  expect(select("defaults", "   ")).toBe("requested");

  await expectWarning("Sticky model selection must be non-empty.");
  expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
});

it("warns and absorbs asynchronous config write failures", async () => {
  mocks.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error("config is read-only"));

  expect(select()).toBe("requested");

  await expectWarning("config is read-only");
});

it("skips Nix immutable config and warns only once per process", () => {
  mocks.isConfigReadOnly = true;
  mocks.isNixMode = true;

  expect(select()).toBe("skipped-immutable");
  expect(select("agent", "provider/other", "work")).toBe("skipped-immutable");

  expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledOnce();
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.stringContaining("config is immutable in OPENCLAW_NIX_MODE"),
  );
});
