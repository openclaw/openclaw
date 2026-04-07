import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing, buildQaRuntimeEnv, resolveQaControlUiRoot } from "./gateway-child.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function createParams(baseEnv?: NodeJS.ProcessEnv) {
  return {
    configPath: "/tmp/openclaw-qa/openclaw.json",
    gatewayToken: "qa-token",
    homeDir: "/tmp/openclaw-qa/home",
    stateDir: "/tmp/openclaw-qa/state",
    xdgConfigHome: "/tmp/openclaw-qa/xdg-config",
    xdgDataHome: "/tmp/openclaw-qa/xdg-data",
    xdgCacheHome: "/tmp/openclaw-qa/xdg-cache",
    baseEnv,
  };
}

describe("buildQaRuntimeEnv", () => {
  it("keeps the slow-reply QA opt-out enabled under fast mode", () => {
    const env = buildQaRuntimeEnv({
      ...createParams(),
      providerMode: "mock-openai",
    });

    expect(env.OPENCLAW_TEST_FAST).toBe("1");
    expect(env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER).toBe("1");
    expect(env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS).toBe("1");
  });

  it("maps live frontier key aliases into provider env vars", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
        OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
        OPENCLAW_LIVE_GEMINI_KEY: "gemini-live",
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENAI_API_KEY).toBe("openai-live");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-live");
    expect(env.GEMINI_API_KEY).toBe("gemini-live");
  });

  it("keeps explicit provider env vars over live aliases", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENAI_API_KEY: "openai-explicit",
        OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENAI_API_KEY).toBe("openai-explicit");
  });

  it("scrubs direct and live provider keys in mock mode", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        ANTHROPIC_API_KEY: "anthropic-live",
        ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth",
        GEMINI_API_KEY: "gemini-live",
        GEMINI_API_KEYS: "gemini-a gemini-b",
        GOOGLE_API_KEY: "google-live",
        OPENAI_API_KEY: "openai-live",
        OPENAI_API_KEYS: "openai-a,openai-b",
        OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
        OPENCLAW_LIVE_ANTHROPIC_KEYS: "anthropic-a,anthropic-b",
        OPENCLAW_LIVE_GEMINI_KEY: "gemini-live",
        OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
      }),
      providerMode: "mock-openai",
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEYS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEYS).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.OPENCLAW_LIVE_OPENAI_KEY).toBeUndefined();
    expect(env.OPENCLAW_LIVE_ANTHROPIC_KEY).toBeUndefined();
    expect(env.OPENCLAW_LIVE_ANTHROPIC_KEYS).toBeUndefined();
    expect(env.OPENCLAW_LIVE_GEMINI_KEY).toBeUndefined();
  });

  it("treats restart socket closures as retryable gateway call errors", () => {
    expect(__testing.isRetryableGatewayCallError("gateway closed (1006 abnormal closure)")).toBe(
      true,
    );
    expect(__testing.isRetryableGatewayCallError("gateway closed (1012 service restart)")).toBe(
      true,
    );
    expect(__testing.isRetryableGatewayCallError("service restart in progress")).toBe(true);
    expect(__testing.isRetryableGatewayCallError("permission denied")).toBe(false);
  });
});

describe("resolveQaControlUiRoot", () => {
  it("returns the built control ui root when repo assets exist", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-control-ui-root-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    const controlUiRoot = path.join(repoRoot, "dist", "control-ui");
    await mkdir(controlUiRoot, { recursive: true });
    await writeFile(path.join(controlUiRoot, "index.html"), "<html></html>", "utf8");

    expect(resolveQaControlUiRoot({ repoRoot })).toBe(controlUiRoot);
  });

  it("returns undefined when control ui is disabled or not built", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-control-ui-root-missing-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });

    expect(resolveQaControlUiRoot({ repoRoot })).toBeUndefined();
    expect(resolveQaControlUiRoot({ repoRoot, controlUiEnabled: false })).toBeUndefined();
  });
});
