import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";

// Force planOpenClawModelsJson to return "skip" so the bootstrap fallback is exercised.
vi.mock("./models-config.plan.js", () => ({
  planOpenClawModelsJson: async () => ({ action: "skip" as const }),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
}));

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles/store.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

beforeEach(async () => {
  vi.resetModules();
  ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots } = await import("./auth-profiles/store.js"));
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
});

describe("non-main agent models.json bootstrap", () => {
  it("copies main agent models.json when plan skips for a non-main agent", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");

        // Point resolveOpenClawAgentDir at the temp main agent dir.
        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        // Seed the main agent's models.json.
        const mainModelsContent = JSON.stringify(
          {
            providers: {
              openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
            },
          },
          null,
          2,
        );
        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(path.join(mainAgentDir, "models.json"), mainModelsContent);

        // Ensure the non-main agent dir does NOT have models.json yet.
        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");
        await expect(fs.access(nonMainModelsPath)).rejects.toThrow();

        // Run ensureOpenClawModelsJson for the non-main agent.
        const result = await ensureOpenClawModelsJson({}, nonMainAgentDir);

        expect(result.wrote).toBe(true);
        expect(result.agentDir).toBe(nonMainAgentDir);

        // Verify the file was bootstrapped from main.
        const copied = await fs.readFile(nonMainModelsPath, "utf-8");
        expect(copied.trim()).toBe(mainModelsContent.trim());
      });
    });
  });

  it("returns skip when main agent also has no models.json", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        // No main models.json — bootstrap should gracefully fall through.
        const result = await ensureOpenClawModelsJson({}, nonMainAgentDir);

        expect(result.wrote).toBe(false);
      });
    });
  });

  it("does not bootstrap when agentDir is the main agent dir", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        // Even with a main models.json, skip should not self-bootstrap.
        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          JSON.stringify({ providers: { test: {} } }),
        );

        const result = await ensureOpenClawModelsJson({}, mainAgentDir);

        expect(result.wrote).toBe(false);
      });
    });
  });

  it("does not rewrite an existing non-main models.json on repeated calls", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        const mainModelsContent = JSON.stringify(
          {
            providers: {
              openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
            },
          },
          null,
          2,
        );
        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(path.join(mainAgentDir, "models.json"), mainModelsContent);

        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");
        const first = await ensureOpenClawModelsJson({}, nonMainAgentDir);
        expect(first.wrote).toBe(true);

        resetModelsJsonReadyCacheForTest();
        const firstStat = await fs.stat(nonMainModelsPath);

        const second = await ensureOpenClawModelsJson({}, nonMainAgentDir);
        expect(second.wrote).toBe(false);

        const secondStat = await fs.stat(nonMainModelsPath);
        expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
        await expect(fs.readFile(nonMainModelsPath, "utf-8")).resolves.toBe(mainModelsContent);
      });
    });
  });

  it("does not overwrite an existing non-main models.json when plan skips", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");
        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          JSON.stringify({ providers: { openai: { apiKey: "sk-main" } } }, null, 2),
        );

        const existingNonMainContent = JSON.stringify(
          { providers: { openai: { apiKey: "sk-worker" } } },
          null,
          2,
        );
        await fs.mkdir(nonMainAgentDir, { recursive: true });
        await fs.writeFile(nonMainModelsPath, existingNonMainContent);

        const result = await ensureOpenClawModelsJson({}, nonMainAgentDir);

        expect(result.wrote).toBe(false);
        await expect(fs.readFile(nonMainModelsPath, "utf-8")).resolves.toBe(existingNonMainContent);
      });
    });
  });

  it("propagates bootstrap write errors instead of silently skipping", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");
        const blockingParentPath = path.join(home, "agents", "worker");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          JSON.stringify({ providers: { openai: { apiKey: "sk-main" } } }, null, 2),
        );

        await fs.writeFile(blockingParentPath, "not-a-directory");

        await expect(ensureOpenClawModelsJson({}, nonMainAgentDir)).rejects.toThrow();
      });
    });
  });

  it("retries bootstrap after the main models.json appears later", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");
        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        const first = await ensureOpenClawModelsJson({}, nonMainAgentDir);
        expect(first.wrote).toBe(false);

        const mainModelsContent = JSON.stringify(
          { providers: { openai: { apiKey: "sk-main" } } },
          null,
          2,
        );
        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(path.join(mainAgentDir, "models.json"), mainModelsContent);

        const second = await ensureOpenClawModelsJson({}, nonMainAgentDir);
        expect(second.wrote).toBe(true);
        await expect(fs.readFile(nonMainModelsPath, "utf-8")).resolves.toBe(mainModelsContent);
      });
    });
  });

  it("retries bootstrap after an empty main models.json gets populated", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");
        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");
        const mainModelsPath = path.join(mainAgentDir, "models.json");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        // Seed main with an empty models.json.
        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(mainModelsPath, "  \n");

        const first = await ensureOpenClawModelsJson({}, nonMainAgentDir);
        expect(first.wrote).toBe(false);

        // Now populate main with valid content.
        const mainModelsContent = JSON.stringify(
          { providers: { openai: { apiKey: "sk-main" } } },
          null,
          2,
        );
        await fs.writeFile(mainModelsPath, mainModelsContent);

        const second = await ensureOpenClawModelsJson({}, nonMainAgentDir);
        expect(second.wrote).toBe(true);
        await expect(fs.readFile(nonMainModelsPath, "utf-8")).resolves.toBe(mainModelsContent);
      });
    });
  });

  it("does not depend on main readability when non-main models.json already exists", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");
        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        const existingNonMainContent = JSON.stringify(
          { providers: { openai: { apiKey: "sk-worker" } } },
          null,
          2,
        );
        await fs.mkdir(nonMainAgentDir, { recursive: true });
        await fs.writeFile(nonMainModelsPath, existingNonMainContent);

        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.mkdir(path.join(mainAgentDir, "models.json"));

        await expect(ensureOpenClawModelsJson({}, nonMainAgentDir)).resolves.toEqual({
          agentDir: nonMainAgentDir,
          wrote: false,
        });
        await expect(fs.readFile(nonMainModelsPath, "utf-8")).resolves.toBe(existingNonMainContent);
      });
    });
  });

  it("preserves a malformed non-main models.json instead of overwriting it from main", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");
        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          JSON.stringify({ providers: { openai: { apiKey: "sk-main" } } }, null, 2),
        );

        const malformedNonMainContent = "{ invalid json";
        await fs.mkdir(nonMainAgentDir, { recursive: true });
        await fs.writeFile(nonMainModelsPath, malformedNonMainContent);

        await expect(ensureOpenClawModelsJson({}, nonMainAgentDir)).resolves.toEqual({
          agentDir: nonMainAgentDir,
          wrote: false,
        });
        await expect(fs.readFile(nonMainModelsPath, "utf-8")).resolves.toBe(
          malformedNonMainContent,
        );
      });
    });
  });

  it("propagates unreadable non-main models.json errors instead of overwriting from main", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const mainAgentDir = path.join(home, "agents", "main", "agent");
        const nonMainAgentDir = path.join(home, "agents", "worker", "agent");
        const nonMainModelsPath = path.join(nonMainAgentDir, "models.json");

        process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
        process.env.PI_CODING_AGENT_DIR = mainAgentDir;

        await fs.mkdir(mainAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(mainAgentDir, "models.json"),
          JSON.stringify({ providers: { openai: { apiKey: "sk-main" } } }, null, 2),
        );

        const existingNonMainContent = JSON.stringify(
          { providers: { openai: { apiKey: "sk-worker" } } },
          null,
          2,
        );
        await fs.mkdir(nonMainAgentDir, { recursive: true });
        await fs.writeFile(nonMainModelsPath, existingNonMainContent);

        const originalReadFile = fs.readFile.bind(fs);
        vi.spyOn(fs, "readFile").mockImplementation(async (pathname, options) => {
          if (pathname === nonMainModelsPath && options === "utf8") {
            const error = new Error("permission denied");
            Object.assign(error, { code: "EACCES" });
            throw error;
          }
          return originalReadFile(pathname, options);
        });

        await expect(ensureOpenClawModelsJson({}, nonMainAgentDir)).rejects.toMatchObject({
          code: "EACCES",
        });
        await expect(fs.readFile(nonMainModelsPath, "utf-8")).resolves.toBe(existingNonMainContent);
      });
    });
  });
});
