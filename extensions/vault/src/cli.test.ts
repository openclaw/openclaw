import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerVaultCommands } from "./cli.js";

type VaultPlan = {
  providerUpserts: Record<string, unknown>;
  targets: Array<Record<string, unknown>>;
};

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

function createProgram(config: Record<string, unknown> = {}): Command {
  const program = new Command();
  program.exitOverride();
  registerVaultCommands({ program, config: config as never });
  return program;
}

async function createSetupPlan(args: string[]): Promise<VaultPlan> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-cli-"));
  const planPath = path.join(dir, "plan.json");
  try {
    await runSetup(planPath, args);
    return JSON.parse(await fs.readFile(planPath, "utf8")) as VaultPlan;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runSetup(planPath: string, args: string[]): Promise<string> {
  const stdout = captureStdout();
  try {
    await createProgram().parseAsync(["vault", "setup", "--plan-out", planPath, ...args], {
      from: "user",
    });
    return stdout.output();
  } finally {
    stdout.restore();
  }
}

async function runStatus(
  config: Record<string, unknown>,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  const stdout = captureStdout();
  try {
    await createProgram(config).parseAsync(["vault", "status", "--json", ...args], {
      from: "user",
    });
    return JSON.parse(stdout.output()) as Record<string, unknown>;
  } finally {
    stdout.restore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vault CLI setup plan", () => {
  const setupArgs = ["--openai-id", "providers/openai/apiKey"];

  it.skipIf(process.platform === "win32").each([0o700, 0o755])(
    "creates private plans in a %o directory without overwriting files or following symlinks",
    async (directoryMode) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-plan-security-"));
      const privatePath = path.join(dir, "private.json");
      const existingPath = path.join(dir, "existing.json");
      const targetPath = path.join(dir, "target.json");
      const symlinkPath = path.join(dir, "symlink.json");
      try {
        await fs.chmod(dir, directoryMode);
        await runSetup(privatePath, setupArgs);
        expect((await fs.stat(privatePath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(dir)).mode & 0o777).toBe(directoryMode);
        await fs.writeFile(existingPath, "keep-me", "utf8");
        await expect(runSetup(existingPath, setupArgs)).rejects.toThrow("Plan path already exists");
        await expect(fs.readFile(existingPath, "utf8")).resolves.toBe("keep-me");
        await fs.writeFile(targetPath, "keep-me", "utf8");
        await fs.symlink(targetPath, symlinkPath);
        await expect(runSetup(symlinkPath, setupArgs)).rejects.toThrow("Plan path already exists");
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("keep-me");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("generates plugin-managed provider config and model API-key targets", async () => {
    const plan = await createSetupPlan([
      "--openai-id",
      "providers/openai/apiKey",
      "--anthropic-id",
      "providers/anthropic/apiKey",
      "--provider-key",
      "local-openai=providers/local-openai/apiKey",
    ]);

    expect(plan.providerUpserts).toEqual({
      vault: {
        source: "exec",
        pluginIntegration: { pluginId: "vault", integrationId: "vault" },
      },
    });
    expect(plan.targets).toEqual([
      expect.objectContaining({
        type: "models.providers.apiKey",
        path: "models.providers.openai.apiKey",
        providerId: "openai",
        ref: { source: "exec", provider: "vault", id: "providers/openai/apiKey" },
      }),
      expect.objectContaining({
        type: "models.providers.apiKey",
        path: "models.providers.anthropic.apiKey",
        providerId: "anthropic",
      }),
      expect.objectContaining({
        type: "models.providers.apiKey",
        path: "models.providers.local-openai.apiKey",
        providerId: "local-openai",
      }),
    ]);
  });

  it("preserves colon-bearing auth-profile target paths", async () => {
    const plan = await createSetupPlan([
      "--target",
      "auth-profiles:main:profiles.openai:default.key=providers/openai/apiKey",
    ]);

    expect(plan.targets).toEqual([
      expect.objectContaining({
        type: "auth-profiles.api_key.key",
        path: "profiles.openai:default.key",
        agentId: "main",
      }),
    ]);
  });

  it.each(["providers/../openai/apiKey", "providers//openai/apiKey", "apiKey"])(
    "rejects non-canonical Vault secret id %s",
    async (secretId) => {
      await expect(createSetupPlan(["--provider-key", `openai=${secretId}`])).rejects.toThrow(
        "Invalid --provider-key openai Vault secret id",
      );
    },
  );
});

describe("vault CLI status", () => {
  it("prefers the managed integration when the default alias is unrelated", async () => {
    const result = await runStatus({
      secrets: {
        providers: {
          vault: { source: "exec", command: "/legacy/resolver" },
          "corp-vault": {
            source: "exec",
            pluginIntegration: { pluginId: "vault", integrationId: "vault" },
          },
        },
      },
    });
    expect(result.providerAlias).toBe("corp-vault");
  });

  it("requires an explicit alias when multiple Vault providers are configured", async () => {
    const config = {
      secrets: {
        providers: Object.fromEntries(
          ["corp-vault", "prod-vault"].map((alias) => [
            alias,
            {
              source: "exec",
              pluginIntegration: { pluginId: "vault", integrationId: "vault" },
            },
          ]),
        ),
      },
    };
    await expect(runStatus(config)).rejects.toThrow("Multiple Vault provider aliases");
    expect((await runStatus(config, ["--provider-alias", "prod-vault"])).providerAlias).toBe(
      "prod-vault",
    );
  });

  it("reports the packaged resolver fallback through the status command", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (filePath) => {
      if (String(filePath).includes("extensions/vault/vault-secret-ref-resolver.js")) {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const result = await runStatus({});
    expect(result.resolverScript).toMatch(/extensions\/vault\/vault-secret-ref-resolver\.js$/u);
  });
});
