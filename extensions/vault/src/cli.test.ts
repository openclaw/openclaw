import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerVaultCommands } from "./cli.js";

async function runVault(args: string[], config: OpenClawConfig = {}): Promise<string> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    const program = new Command().exitOverride();
    registerVaultCommands({ program, config });
    await program.parseAsync(["vault", ...args], { from: "user" });
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

function runSetup(planPath: string, args: string[]) {
  return runVault(["setup", "--plan-out", planPath, ...args]);
}

async function createSetupPlan(args: string[]): Promise<{ targets: Record<string, unknown>[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-cli-"));
  const planPath = path.join(dir, "plan.json");
  try {
    await runSetup(planPath, args);
    return JSON.parse(await fs.readFile(planPath, "utf8"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runStatus(config: OpenClawConfig, args: string[] = []) {
  const output = await runVault(["status", "--json", ...args], config);
  return JSON.parse(output) as Record<string, unknown>;
}

describe("vault CLI setup plan", () => {
  const setupArgs = ["--openai-id", "providers/openai/apiKey"];

  it.skipIf(process.platform === "win32")(
    "creates private plans in a readable directory without overwriting files or following symlinks",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vault-plan-security-"));
      const privatePath = path.join(dir, "private.json");
      const existingPath = path.join(dir, "existing.json");
      const targetPath = path.join(dir, "target.json");
      const symlinkPath = path.join(dir, "symlink.json");
      try {
        await fs.chmod(dir, 0o755);
        await runSetup(privatePath, setupArgs);
        expect((await fs.stat(privatePath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o755);
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

  it.each([
    ["providers/../openai/apiKey", "must not contain dot path segments"],
    ["providers//openai/apiKey", "must not contain empty path segments"],
    ["apiKey", 'must use "<path>/<field>", for example "providers/openai/apiKey"'],
  ])("rejects non-canonical Vault secret id %s", async (secretId, reason) => {
    await expect(createSetupPlan(["--provider-key", `openai=${secretId}`])).rejects.toThrow(reason);
  });
});

it("requires an explicit alias when multiple Vault providers are configured", async () => {
  const provider = {
    source: "exec",
    pluginIntegration: { pluginId: "vault", integrationId: "vault" },
  } as const;
  const config = {
    secrets: { providers: { "corp-vault": provider, "prod-vault": provider } },
  };
  await expect(runStatus(config)).rejects.toThrow("Multiple Vault provider aliases");
  expect((await runStatus(config, ["--provider-alias", "prod-vault"])).providerAlias).toBe(
    "prod-vault",
  );
});
