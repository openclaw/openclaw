import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { prepareQaGatewayChild, type QaGatewayChildParams } from "./gateway-child-setup.js";
import {
  QA_PROVIDER_SECRET_ENV_KEY_PATTERNS,
  QA_PROVIDER_SECRET_ENV_VARS,
} from "./providers/env.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

// Exercise preparation without starting a Gateway or staging the full repository.
export function createQaGatewaySetupHarness() {
  const dirs = createTempDirHarness();
  const lifetimes: QaGatewayChildLifecycle[] = [];
  return {
    async prepare(params: Partial<QaGatewayChildParams> = {}, parentEnv: NodeJS.ProcessEnv = {}) {
      const root = await fs.realpath(await dirs.makeTempDir("qa-gateway-setup-"));
      const repoRoot = path.join(root, "repo");
      await fs.mkdir(repoRoot);
      await fs.writeFile(path.join(repoRoot, "package.json"), '{"version":"2026.4.8"}\n');
      for (const key of [
        ...QA_PROVIDER_SECRET_ENV_VARS,
        ...Object.keys(process.env).filter((envKey) =>
          QA_PROVIDER_SECRET_ENV_KEY_PATTERNS.some((pattern) => pattern.test(envKey)),
        ),
        "CODEX_HOME",
        "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV",
        "OPENCLAW_QA_CODEX_API_KEY_HANDOFF",
        "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN",
        "OPENCLAW_LIVE_SETUP_TOKEN_VALUE",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_PROVIDERS",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_CODEX_APP_SERVER_ARGS",
        "OPENCLAW_QA_FORCE_RUNTIME",
      ]) {
        vi.stubEnv(key, undefined);
      }
      for (const [key, value] of Object.entries({
        HOME: path.join(root, "parent-home"),
        OPENCLAW_HOME: path.join(root, "parent-home"),
        OPENCLAW_STATE_DIR: path.join(root, "parent-state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "parent-config.json"),
        OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: path.join(root, "parent-config.json"),
        XDG_CONFIG_HOME: path.join(root, "parent-config"),
        XDG_DATA_HOME: path.join(root, "parent-data"),
        XDG_CACHE_HOME: path.join(root, "parent-cache"),
        ...parentEnv,
      })) {
        vi.stubEnv(key, value);
      }
      const lifetime = new QaGatewayChildLifecycle();
      lifetimes.push(lifetime);
      const prepared = await prepareQaGatewayChild(
        {
          repoRoot,
          command: { executablePath: process.execPath, tempParentDir: root },
          transportBaseUrl: "http://127.0.0.1:43123",
          mockAuthAgentIds: [],
          ...params,
        },
        lifetime,
      );
      const attempt = await prepared.prepareAttempt();
      return { ...prepared, ...attempt, lifetime };
    },
    async cleanup() {
      try {
        for (const lifetime of lifetimes.splice(0)) {
          const result = await lifetime.stop({ keepTemp: false });
          if (result.errors.length) {
            throw new AggregateError(result.errors, "QA preparation fixture cleanup failed");
          }
        }
        await dirs.cleanup();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  };
}
