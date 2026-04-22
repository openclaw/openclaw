import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelsJsonAuthProfilesFingerprint } from "./models-config.auth-fingerprint.js";
import { installModelsConfigTestHooks, withModelsTempHome } from "./models-config.e2e-harness.js";

const planOpenClawModelsJsonMock = vi.fn();

installModelsConfigTestHooks();

let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

beforeAll(async () => {
  vi.doMock("./models-config.plan.js", () => ({
    planOpenClawModelsJson: (...args: unknown[]) => planOpenClawModelsJsonMock(...args),
  }));
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
});

beforeEach(() => {
  planOpenClawModelsJsonMock.mockReset().mockResolvedValue({ action: "noop" });
});

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

async function prepareCachedEnsure(agentDir: string): Promise<{
  authPath: string;
  modelsPath: string;
}> {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const modelsPath = path.join(agentDir, "models.json");
  await writeJson(modelsPath, { providers: {} });
  await writeJson(authPath, {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-test-one",
      },
    },
  });
  await ensureOpenClawModelsJson({}, agentDir);
  expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
  return { authPath, modelsPath };
}

describe("models-config auth profiles semantic fingerprint", () => {
  it("keeps the models-config cache warm when auth-profiles.json is rewritten without semantic changes", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const { authPath } = await prepareCachedEnsure(agentDir);

      await writeJson(authPath, {
        profiles: {
          "openai:default": {
            provider: "openai",
            key: "sk-test-one",
            type: "api_key",
          },
        },
        version: 1,
      });
      await fs.utimes(authPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:01:00Z"));

      await ensureOpenClawModelsJson({}, agentDir);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    });
  });

  it("invalidates the models-config cache when auth semantics change", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const { authPath } = await prepareCachedEnsure(agentDir);

      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-two",
          },
        },
      });

      await ensureOpenClawModelsJson({}, agentDir);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
    });
  });

  it("invalidates the models-config cache when auth profile order changes", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      const modelsPath = path.join(agentDir, "models.json");
      await writeJson(modelsPath, { providers: {} });
      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-default",
          },
          "openai:work": {
            type: "api_key",
            provider: "openai",
            key: "sk-test-work",
          },
        },
      });
      await ensureOpenClawModelsJson({}, agentDir);
      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);

      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:work": {
            provider: "openai",
            key: "sk-test-work",
            type: "api_key",
          },
          "openai:default": {
            provider: "openai",
            key: "sk-test-default",
            type: "api_key",
          },
        },
      });

      await ensureOpenClawModelsJson({}, agentDir);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
    });
  });

  it("continues to invalidate when models.json changes", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const { modelsPath } = await prepareCachedEnsure(agentDir);

      await writeJson(modelsPath, { providers: { changed: { models: [] } } });
      await fs.utimes(
        modelsPath,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T00:01:00Z"),
      );

      await ensureOpenClawModelsJson({}, agentDir);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
    });
  });

  it("fingerprints SecretRef identity and env values without exposing secret material", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      const previousAuthKey = process.env.OPENCLAW_TEST_AUTH_KEY;
      process.env.OPENCLAW_TEST_AUTH_KEY = "super-secret-one";
      try {
        await writeJson(authPath, {
          version: 1,
          profiles: {
            "env:default": {
              type: "api_key",
              provider: "env-provider",
              keyRef: { source: "env", provider: "default", id: "OPENCLAW_TEST_AUTH_KEY" },
            },
            "file:default": {
              type: "api_key",
              provider: "file-provider",
              keyRef: { source: "file", provider: "vault", id: "/secret/openai" },
            },
            "exec:default": {
              type: "token",
              provider: "exec-provider",
              tokenRef: { source: "exec", provider: "vault", id: "token/openai" },
            },
          },
        });

        const first = await buildModelsJsonAuthProfilesFingerprint(agentDir);
        const serializedFirst = JSON.stringify(first);
        expect(serializedFirst).not.toContain("super-secret-one");

        process.env.OPENCLAW_TEST_AUTH_KEY = "super-secret-two";
        const second = await buildModelsJsonAuthProfilesFingerprint(agentDir);

        expect(second).not.toEqual(first);
        expect(JSON.stringify(second)).not.toContain("super-secret-two");
      } finally {
        if (previousAuthKey === undefined) {
          delete process.env.OPENCLAW_TEST_AUTH_KEY;
        } else {
          process.env.OPENCLAW_TEST_AUTH_KEY = previousAuthKey;
        }
      }
    });
  });

  it("ignores idempotent OAuth token refreshes when stable identity and expiry bucket do not change", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      const expires = Date.now() + 60 * 60 * 1000;
      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            accountId: "acct_123",
            email: "USER@example.com",
            access: "access-token-one",
            refresh: "refresh-token-one",
            expires,
          },
        },
      });
      const first = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            accountId: "acct_123",
            email: "user@example.com",
            access: "access-token-two",
            refresh: "refresh-token-two",
            expires: expires + 1000,
          },
        },
      });
      const second = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      expect(second).toEqual(first);
      expect(JSON.stringify(second)).not.toContain("access-token-two");
      expect(JSON.stringify(second)).not.toContain("refresh-token-two");
    });
  });

  it("changes OAuth fingerprint when stable identity changes", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            accountId: "acct_123",
            access: "access-token-one",
            refresh: "refresh-token-one",
            expires: Date.now() + 60 * 60 * 1000,
          },
        },
      });
      const first = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            accountId: "acct_456",
            access: "access-token-two",
            refresh: "refresh-token-two",
            expires: Date.now() + 60 * 60 * 1000,
          },
        },
      });
      const second = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      expect(second).not.toEqual(first);
    });
  });

  it("normalizes mixed string and array OAuth audience claims without splitting strings", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      const access = unsignedJwt({ aud: ["api-b", "api-a"] });
      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            idToken: unsignedJwt({ aud: "id-audience" }),
            access,
            expires: Date.now() + 60 * 60 * 1000,
          },
        },
      });
      const mixedAudience = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      await writeJson(authPath, {
        version: 1,
        profiles: {
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            idToken: unsignedJwt({}),
            access,
            expires: Date.now() + 60 * 60 * 1000,
          },
        },
      });
      const accessArrayAudience = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      expect(mixedAudience).toEqual(accessArrayAudience);
    });
  });

  it("uses raw content for parse errors and does not collapse read errors into a safe hit", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(authPath, "{not-json", "utf8");
      const parseError = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      await fs.writeFile(authPath, "{not-json-but-different", "utf8");
      const changedParseError = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      await fs.rm(authPath, { force: true });
      await fs.mkdir(authPath);
      const readError = await buildModelsJsonAuthProfilesFingerprint(agentDir);

      expect(parseError).toMatchObject({ status: "parse_error" });
      expect(changedParseError).toMatchObject({ status: "parse_error" });
      expect(changedParseError).not.toEqual(parseError);
      expect(readError).toMatchObject({ status: "read_error", errorCode: "EISDIR" });
    });
  });

  it("does not keep a ready-cache entry when ensure planning fails", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      await writeJson(path.join(agentDir, "models.json"), { providers: {} });
      await writeJson(path.join(agentDir, "auth-profiles.json"), {
        version: 1,
        profiles: {},
      });
      planOpenClawModelsJsonMock.mockRejectedValueOnce(new Error("planned failure"));

      await expect(ensureOpenClawModelsJson({}, agentDir)).rejects.toThrow("planned failure");
      planOpenClawModelsJsonMock.mockResolvedValueOnce({ action: "noop" });
      await ensureOpenClawModelsJson({}, agentDir);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
      resetModelsJsonReadyCacheForTest();
    });
  });
});
