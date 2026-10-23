import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveTrustedOnePasswordCli } from "../onepassword-op-path.js";
import { registerOnePasswordSecretRefCommands } from "./secret-ref-cli.js";

const readTokenFileMock = vi.hoisted(() =>
  vi.fn<
    (
      filePath: string | undefined,
      label: string,
      options?: Parameters<typeof tryReadSecretFileSync>[2],
    ) => string | undefined
  >(),
);
const tokenFile = path.join(os.tmpdir(), "openclaw-onepassword-missing-token");
const pluginIntegration = { pluginId: "onepassword", integrationId: "onepassword" };
const provider = { source: "exec", pluginIntegration } as const;

vi.mock("../onepassword-op-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onepassword-op-path.js")>()),
  resolveTrustedOnePasswordCli: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/secret-file-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/secret-file-runtime")>()),
  tryReadSecretFileSync: readTokenFileMock,
}));

let tempDir: string;
beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onepassword-cli-"));
  vi.stubEnv("PATH", "");
  vi.stubEnv("CLAW_1PASSWORD_OP", undefined);
  vi.mocked(resolveTrustedOnePasswordCli).mockReset();
  readTokenFileMock.mockReset();
});

type OnePasswordPlan = {
  providerUpserts: Record<string, unknown>;
  targets: Array<Record<string, unknown>>;
};

async function run(args: string[], config: OpenClawConfig = {}): Promise<string> {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const program = new Command().exitOverride();
  registerOnePasswordSecretRefCommands({
    command: program.command("onepassword"),
    config,
    tokenFile,
  });
  await program.parseAsync(["onepassword", "secretref", ...args], { from: "user" });
  return output;
}

async function runStatus(config: OpenClawConfig): Promise<Record<string, unknown>> {
  return JSON.parse(await run(["status", "--json"], config)) as Record<string, unknown>;
}

const runSetup = (planPath: string, args = ["--openai-id", "op://openclaw/OpenAI/credential"]) =>
  run(["setup", "--plan-out", planPath, ...args]);

async function createSetupPlan(args: string[]): Promise<OnePasswordPlan> {
  const planPath = path.join(tempDir, "plan.json");
  await runSetup(planPath, args);
  return JSON.parse(await fs.readFile(planPath, "utf8")) as OnePasswordPlan;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tempDir, { recursive: true, force: true });
});

it("builds provider config and model API-key targets", async () => {
  const plan = await createSetupPlan([
    "--anthropic-id",
    "op://openclaw/Anthropic/credential",
    "--openrouter-id",
    "openclaw/OpenRouter/credential",
    "--provider-key",
    "xai=op://openclaw/xAI/credential",
  ]);

  expect(plan.providerUpserts.onepassword).toEqual(provider);
  expect(plan.targets).toEqual([
    expect.objectContaining({
      type: "models.providers.apiKey",
      providerId: "anthropic",
      ref: { source: "exec", provider: "onepassword", id: "op://openclaw/Anthropic/credential" },
    }),
    expect.objectContaining({ providerId: "openrouter" }),
    expect.objectContaining({ providerId: "xai" }),
  ]);
});

it.each(["op://openclaw/../credential", "op://openclaw\\OpenAI\\credential", "op://vault/clé"])(
  "rejects invalid 1Password ref %s",
  async (id) => {
    await expect(createSetupPlan(["--provider-key", `openai=${id}`])).rejects.toThrow(
      "Invalid --provider-key openai 1Password SecretRef id",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "rejects plan output in a directory writable by another account",
  async () => {
    const planPath = path.join(tempDir, "plan.json");
    await fs.chmod(tempDir, 0o777);
    await expect(runSetup(planPath)).rejects.toThrow("path is writable by another user");
    await expect(fs.stat(planPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(process.platform === "win32")(
  "writes through the canonical directory instead of a replaceable alias",
  async () => {
    const trustedDir = path.join(tempDir, "trusted");
    const aliasParent = path.join(tempDir, "alias");
    await fs.mkdir(trustedDir);
    await fs.mkdir(aliasParent);
    const aliasDir = path.join(aliasParent, "output");
    const canonicalPlanPath = path.join(await fs.realpath(trustedDir), "plan.json");
    await fs.symlink(trustedDir, aliasDir);
    await fs.chmod(aliasParent, 0o777);
    const output = await runSetup(path.join(aliasDir, "plan.json"));
    expect(output).toContain(`Plan written to ${canonicalPlanPath}`);
    expect(JSON.parse(await fs.readFile(canonicalPlanPath, "utf8"))).toMatchObject({ version: 1 });
  },
);

it("reports trusted executable and token prerequisites without exposing the token", async () => {
  vi.stubEnv("CLAW_1PASSWORD_OP", "/trusted/op");
  vi.stubEnv("PATH", "/bin");
  vi.mocked(resolveTrustedOnePasswordCli).mockResolvedValue("/trusted/op");
  readTokenFileMock.mockReturnValue("not-a-real-service-account-token");
  const result = await runStatus({});
  expect(result).toMatchObject({
    opCommand: "/trusted/op",
    opBinaryPath: "/trusted/op",
    opStatus: "ready",
    tokenFile,
    tokenFileStatus: "ready",
    prerequisitesReady: true,
  });
  expect(JSON.stringify(result)).not.toContain("not-a-real-service-account-token");
  expect(resolveTrustedOnePasswordCli).toHaveBeenCalledWith({
    configuredPath: "/trusted/op",
    pathEnv: "/bin",
  });
  expect(tryReadSecretFileSync).toHaveBeenCalledWith(
    tokenFile,
    "1Password service account token",
    expect.objectContaining({ rejectHardlinks: false, rejectSymlink: true }),
  );
});

it("reports untrusted op and unsafe token prerequisites", async () => {
  vi.stubEnv("CLAW_1PASSWORD_OP", "op");
  vi.mocked(resolveTrustedOnePasswordCli).mockRejectedValue(new Error("unsafe path detail"));
  readTokenFileMock.mockImplementation(() => {
    throw new Error("unsafe token detail");
  });
  await expect(runStatus({})).resolves.toMatchObject({
    opCommand: "op",
    opBinaryPath: null,
    opStatus: "untrusted",
    tokenFile,
    tokenFileStatus: "missing-or-unsafe",
    prerequisitesReady: false,
  });
});

it("discovers a configured custom provider alias", async () => {
  const result = await runStatus({ secrets: { providers: { "corp-onepassword": provider } } });
  expect(result).toMatchObject({
    providerAlias: "corp-onepassword",
    providerReady: true,
    opStatus: "not-found",
    tokenFileStatus: "missing-or-unsafe",
    prerequisitesReady: false,
    ready: false,
    issues: ["op-not-found", "token-file-missing-or-unsafe"],
  });
});
