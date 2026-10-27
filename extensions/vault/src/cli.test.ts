import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
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

const runSetup = (planPath: string, args = ["--openai-id", "providers/openai/apiKey"]) =>
  runVault(["setup", "--plan-out", planPath, ...args]);
async function createSetupPlan(args: string[]): Promise<{ targets: Record<string, unknown>[] }> {
  return await withTempDir("openclaw-vault-cli-", async (dir) => {
    const planPath = path.join(dir, "plan.json");
    await runSetup(planPath, args);
    return JSON.parse(await fs.readFile(planPath, "utf8"));
  });
}

it.skipIf(process.platform === "win32")("protects plan files and symlink targets", async () => {
  await withTempDir("openclaw-vault-plan-security-", async (dir) => {
    const privatePath = path.join(dir, "private.json");
    const symlinkPath = path.join(dir, "symlink.json");
    await fs.chmod(dir, 0o755);
    await runSetup(privatePath);
    expect((await fs.stat(privatePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o755);
    await fs.writeFile(privatePath, "keep-me", "utf8");
    await fs.symlink(privatePath, symlinkPath);
    for (const occupiedPath of [privatePath, symlinkPath]) {
      await expect(runSetup(occupiedPath)).rejects.toThrow("Plan path already exists");
      await expect(fs.readFile(privatePath, "utf8")).resolves.toBe("keep-me");
    }
  });
});

it("preserves colon-bearing auth-profile target paths", async () => {
  const plan = await createSetupPlan([
    "--target",
    "auth-profiles:main:profiles.openai:default.key=providers/openai/apiKey",
  ]);
  expect(plan.targets).toMatchObject([
    { type: "auth-profiles.api_key.key", path: "profiles.openai:default.key", agentId: "main" },
  ]);
});

it.each([
  ["providers/../openai/apiKey", "must not contain dot path segments"],
  ["providers//openai/apiKey", "must not contain empty path segments"],
  ["apiKey", 'must use "<path>/<field>", for example "providers/openai/apiKey"'],
])("rejects non-canonical Vault secret id %s", async (secretId, reason) => {
  await expect(createSetupPlan(["--provider-key", `openai=${secretId}`])).rejects.toThrow(reason);
});

it("requires an explicit alias when multiple Vault providers are configured", async () => {
  const provider = {
    source: "exec",
    pluginIntegration: { pluginId: "vault", integrationId: "vault" },
  } as const;
  const config = {
    secrets: { providers: { "corp-vault": provider, "prod-vault": provider } },
  };
  await expect(runVault(["status", "--json"], config)).rejects.toThrow(
    "Multiple Vault provider aliases",
  );
  const output = await runVault(["status", "--json", "--provider-alias", "prod-vault"], config);
  expect(JSON.parse(output).providerAlias).toBe("prod-vault");
});
