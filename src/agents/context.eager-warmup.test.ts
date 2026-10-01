import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../config/config.js", () => ({ getRuntimeConfig: loadConfigMock }));

const originalArgv = process.argv.slice();
afterEach(() => {
  process.argv = originalArgv.slice();
});

it("does not load config when importing context helpers for a lightweight CLI command", async () => {
  process.argv = ["node", "openclaw", "models", "set", "openai/gpt-5.4"];
  await importFreshModule(import.meta.url, "./context.js?scope=models");
  expect(loadConfigMock).not.toHaveBeenCalled();
});
