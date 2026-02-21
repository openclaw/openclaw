import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  requireApiKey,
  resolveApiKeyHelper,
  resolveAwsSdkEnvVarName,
  resolveModelAuthMode,
} from "./model-auth.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const mockedExecFile = vi.mocked(execFile);

describe("resolveAwsSdkEnvVarName", () => {
  it("prefers bearer token over access keys and profile", () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("uses access keys when bearer token is missing", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_ACCESS_KEY_ID");
  });

  it("uses profile when no bearer token or access keys exist", () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_PROFILE");
  });

  it("returns undefined when no AWS auth env is set", () => {
    expect(resolveAwsSdkEnvVarName({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolveModelAuthMode", () => {
  it("returns mixed when provider has both token and api key profiles", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "token-value",
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "api-key",
        },
      },
    };

    expect(resolveModelAuthMode("openai", undefined, store)).toBe("mixed");
  });

  it("returns aws-sdk when provider auth is overridden", () => {
    expect(
      resolveModelAuthMode(
        "amazon-bedrock",
        {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [],
                auth: "aws-sdk",
              },
            },
          },
        },
        { version: 1, profiles: {} },
      ),
    ).toBe("aws-sdk");
  });
});

describe("requireApiKey", () => {
  it("normalizes line breaks in resolved API keys", () => {
    const key = requireApiKey(
      {
        apiKey: "\n sk-test-abc\r\n",
        source: "env: OPENAI_API_KEY",
        mode: "api-key",
      },
      "openai",
    );

    expect(key).toBe("sk-test-abc");
  });

  it("throws when no API key is present", () => {
    expect(() =>
      requireApiKey(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      ),
    ).toThrow('No API key resolved for provider "openai"');
  });
});

describe("resolveApiKeyHelper", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  const makeCfg = (apiKeyHelper?: string, apiKey?: string) => ({
    models: {
      providers: {
        "test-provider": {
          baseUrl: "http://localhost",
          models: [],
          ...(apiKeyHelper !== undefined ? { apiKeyHelper } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
        },
      },
    },
  });

  /** Helper to make mockedExecFile invoke its callback with stdout. */
  const mockExecFileSuccess = (stdout: string) => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, stdout, "");
      return {} as ReturnType<typeof execFile>;
    });
  };

  /** Helper to make mockedExecFile invoke its callback with an error. */
  const mockExecFileError = (err: Error) => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(err, "", "");
      return {} as ReturnType<typeof execFile>;
    });
  };

  it("resolves API key from helper command", async () => {
    mockExecFileSuccess("sk-from-helper");
    const result = await resolveApiKeyHelper(makeCfg("echo 'sk-from-helper'"), "test-provider");
    expect(result).toBe("sk-from-helper");
    const [expectedShell, ...expectedArgs] = buildNodeShellCommand(
      "echo 'sk-from-helper'",
      process.platform,
    );
    expect(mockedExecFile).toHaveBeenCalledWith(
      expectedShell,
      expectedArgs,
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it("trims whitespace from command output", async () => {
    mockExecFileSuccess("  sk-trimmed  \n");
    const result = await resolveApiKeyHelper(makeCfg("some-command"), "test-provider");
    expect(result).toBe("sk-trimmed");
  });

  it("returns null when no apiKeyHelper is configured", async () => {
    const result = await resolveApiKeyHelper(makeCfg(), "test-provider");
    expect(result).toBeNull();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("returns null when helper command fails", async () => {
    mockExecFileError(new Error("command failed"));
    const result = await resolveApiKeyHelper(makeCfg("bad-command"), "test-provider");
    expect(result).toBeNull();
  });

  it("returns null when helper command returns empty output", async () => {
    mockExecFileSuccess("  \n  ");
    const result = await resolveApiKeyHelper(makeCfg("empty-output"), "test-provider");
    expect(result).toBeNull();
  });

  it("resolves a dummy dash key (Tailscale Aperture pattern)", async () => {
    mockExecFileSuccess("-\n");
    const result = await resolveApiKeyHelper(makeCfg("echo '-'"), "test-provider");
    expect(result).toBe("-");
  });

  it("returns null on timeout (command throws)", async () => {
    const err = new Error("ETIMEDOUT");
    (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
    mockExecFileError(err);
    const result = await resolveApiKeyHelper(makeCfg("slow-command"), "test-provider");
    expect(result).toBeNull();
  });
});

describe("resolveModelAuthMode with apiKeyHelper", () => {
  it("returns api-key when apiKeyHelper is configured", () => {
    const result = resolveModelAuthMode(
      "test-provider",
      {
        models: {
          providers: {
            "test-provider": {
              baseUrl: "http://localhost",
              apiKeyHelper: "echo 'key'",
              models: [],
            },
          },
        },
      },
      { version: 1, profiles: {} },
    );
    expect(result).toBe("api-key");
  });

  it("apiKeyHelper takes precedence over inline apiKey in auth mode", () => {
    const result = resolveModelAuthMode(
      "test-provider",
      {
        models: {
          providers: {
            "test-provider": {
              baseUrl: "http://localhost",
              apiKeyHelper: "echo 'helper-key'",
              apiKey: "inline-key",
              models: [],
            },
          },
        },
      },
      { version: 1, profiles: {} },
    );
    expect(result).toBe("api-key");
  });
});
