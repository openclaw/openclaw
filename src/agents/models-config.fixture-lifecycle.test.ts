import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setTestEnvValue, withEnvAsync } from "../test-utils/env.js";

type Hook = () => unknown;
const setup: Hook[] = [];
const teardown: Hook[] = [];

beforeAll(async () => {
  vi.doMock("vitest", () => ({
    beforeEach: (hook: Hook) => setup.push(hook),
    afterEach: (hook: Hook) => teardown.push(hook),
  }));
  vi.doMock("../config/config.js", () => ({
    clearConfigCache: () => {},
    clearRuntimeConfigSnapshot: () => {},
  }));
  vi.doMock("../plugins/loader.test-fixtures.js", () => ({
    resetPluginLoaderTestStateForTest: () => {},
  }));
  vi.doMock("./models-config-state.test-support.js", () => ({
    resetModelsJsonReadyCacheForTest: () => {},
  }));
  vi.doMock("../plugin-sdk/test-helpers/temp-home.js", () => ({
    withTempHomeCore: () => {
      throw new Error("Hook restoration must not acquire a temp home");
    },
  }));
  const { installModelsConfigTestHooks } = await import("./models-config.e2e-harness.js");
  installModelsConfigTestHooks({ resetPluginLoaderState: false });
});

afterAll(() => {
  for (const id of [
    "vitest",
    "../config/config.js",
    "../plugins/loader.test-fixtures.js",
    "./models-config-state.test-support.js",
    "../plugin-sdk/test-helpers/temp-home.js",
  ]) {
    vi.doUnmock(id);
  }
});

describe("models-config fixture environment restoration", () => {
  it.each(
    [undefined, "", "/fixture/original-home"].flatMap((originalHome) =>
      [undefined, "/fixture/original-agent"].map((originalAgentDir) => ({
        originalHome,
        originalAgentDir,
      })),
    ),
  )("restores HOME=$originalHome and agent dir=$originalAgentDir", async (testCase) => {
    await withEnvAsync(
      { HOME: testCase.originalHome, OPENCLAW_AGENT_DIR: testCase.originalAgentDir },
      async () => {
        for (const hook of setup) {
          await hook();
        }
        expect(process.env.OPENCLAW_AGENT_DIR).toBeUndefined();
        setTestEnvValue("HOME", "/fixture/temporary-home");
        setTestEnvValue("OPENCLAW_AGENT_DIR", "/fixture/temporary-agent");
        for (const hook of teardown.toReversed()) {
          await hook();
        }
        // Assert before the outer guard restores the worker's real environment.
        expect(Object.hasOwn(process.env, "HOME")).toBe(testCase.originalHome !== undefined);
        expect(process.env.HOME).toBe(testCase.originalHome);
        expect(process.env.OPENCLAW_AGENT_DIR).toBe(testCase.originalAgentDir);
      },
    );
  });
});
