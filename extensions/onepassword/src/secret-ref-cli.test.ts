import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveTrustedOnePasswordCli } from "../onepassword-op-path.js";
import type { AuditRow } from "./broker.js";
import { registerOnePasswordCommands } from "./cli.js";
import { parseOnePasswordConfig } from "./config.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";
import { registerOnePasswordSecretRefCommands } from "./secret-ref-cli.js";

const pluginIntegration = { pluginId: "onepassword", integrationId: "onepassword" };
const provider = { source: "exec", pluginIntegration } as const;

vi.mock("../onepassword-op-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onepassword-op-path.js")>()),
  resolveTrustedOnePasswordCli: vi.fn(),
}));
let tempDir: string;
let tokenFile: string;
let output = "";
let auditStore: MemoryKeyedStore<AuditRow>;
const brokerConfig = parseOnePasswordConfig({
  vault: "Automation",
  items: {
    alpha: { item: "Sensitive title", policy: "auto" },
    beta: { item: "Other" },
    gamma: { item: "Third", policy: "deny" },
  },
});
beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onepassword-cli-"));
  tokenFile = path.join(tempDir, "token");
  vi.stubEnv("PATH", "");
  vi.stubEnv("CLAW_1PASSWORD_OP", undefined);
  vi.mocked(resolveTrustedOnePasswordCli).mockReset();
  auditStore = new MemoryKeyedStore<AuditRow>();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

async function run(args: string[], config: OpenClawConfig = {}): Promise<string> {
  output = "";
  const program = new Command().exitOverride();
  registerOnePasswordCommands({
    program,
    auditStore,
    resolveConfig: () => brokerConfig,
    resolveOpClient: () => ({ opBin: "/usr/local/bin/op", tokenFilePresent: async () => true }),
    registerAdditionalCommands: (command) =>
      registerOnePasswordSecretRefCommands({ command, config, tokenFile }),
  });
  await program.parseAsync(["onepassword", ...args], { from: "user" });
  return output;
}

const runJson = async (args: string[], config?: OpenClawConfig) =>
  JSON.parse(await run(args, config)) as Record<string, unknown>;
const runStatus = (config: OpenClawConfig) => runJson(["secretref", "status", "--json"], config);

const runSetup = (planPath: string, args = ["--openai-id", "op://openclaw/OpenAI/credential"]) =>
  run(["secretref", "setup", "--plan-out", planPath, ...args]);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tempDir, { recursive: true, force: true });
});

it.each(process.platform === "win32" ? [false] : [false, true])(
  "writes provider targets through a canonical directory (alias: %s)",
  async (alias) => {
    let directory = tempDir;
    if (alias) {
      const parent = path.join(tempDir, "alias");
      await fs.mkdir(parent);
      directory = path.join(parent, "output");
      await fs.symlink(tempDir, directory);
      await fs.chmod(parent, 0o777);
    }
    const planPath = path.join(await fs.realpath(directory), "plan.json");
    expect(
      await runSetup(path.join(directory, "plan.json"), [
        "--openrouter-id",
        "openclaw/OpenRouter/credential",
        "--provider-key",
        "xai=op://openclaw/xAI/credential",
      ]),
    ).toContain(`Plan written to ${planPath}`);
    const plan: unknown = JSON.parse(await fs.readFile(planPath, "utf8"));
    expect(plan).toMatchObject({
      version: 1,
      providerUpserts: { onepassword: provider },
      targets: [
        {
          type: "models.providers.apiKey",
          providerId: "openrouter",
          ref: {
            source: "exec",
            provider: "onepassword",
            id: "openclaw/OpenRouter/credential",
          },
        },
        { providerId: "xai" },
      ],
    });
  },
);

it.each(["op://openclaw/../credential", "op://openclaw\\OpenAI\\credential", "op://vault/clé"])(
  "rejects invalid 1Password ref %s",
  async (id) => {
    await expect(
      runSetup(path.join(tempDir, "plan.json"), ["--provider-key", `openai=${id}`]),
    ).rejects.toThrow("Invalid --provider-key openai 1Password SecretRef id");
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

it.each(["ready", "untrusted", "not-found"] as const)(
  "reports %s prerequisites without exposing tokens",
  async (state) => {
    vi.stubEnv("CLAW_1PASSWORD_OP", state === "not-found" ? undefined : "/trusted/op");
    vi.stubEnv("PATH", "/bin");
    const ready = state === "ready";
    const op = vi.mocked(resolveTrustedOnePasswordCli);
    if (state === "untrusted") {
      op.mockRejectedValue(new Error("unsafe path detail"));
    } else {
      op.mockResolvedValue(ready ? "/trusted/op" : undefined);
    }
    if (state !== "not-found") {
      const source = path.join(tempDir, "token-source");
      await fs.writeFile(source, "not-a-real-service-account-token", { mode: 0o600 });
      if (ready) {
        await fs.link(source, tokenFile);
      } else if (process.platform === "win32") {
        await fs.mkdir(tokenFile);
      } else {
        await fs.symlink(source, tokenFile);
      }
    }
    const result = await runStatus(
      ready ? {} : { secrets: { providers: { "corp-onepassword": provider } } },
    );
    expect(result).toMatchObject({
      opBinaryPath: ready ? "/trusted/op" : null,
      opStatus: state,
      tokenFileStatus: ready ? "ready" : "missing-or-unsafe",
      prerequisitesReady: ready,
      providerAlias: ready ? "onepassword" : "corp-onepassword",
      providerReady: !ready,
      ready: false,
    });
    expect(JSON.stringify(result)).not.toContain("not-a-real-service-account-token");
    if (state === "not-found") {
      expect(result.issues).toEqual(["op-not-found", "token-file-missing-or-unsafe"]);
    }
  },
);

async function seedAudit(...rows: Partial<AuditRow>[]) {
  for (const [index, row] of rows.entries()) {
    await auditStore.register(String(index), {
      timestampMs: (index + 1) * 1000,
      agentId: "agent-a",
      sessionKey: "session-a",
      toolCallId: "call-a",
      slug: "alpha",
      reason: "short",
      outcome: "auto",
      ...row,
    });
  }
}

it("status contains readiness and counts without token or item values", async () => {
  expect(await runJson(["status"])).toEqual({
    tokenFilePresent: true,
    opBinaryResolved: true,
    opBinaryPath: "/usr/local/bin/op",
    itemCount: 3,
    policyCounts: { auto: 1, approve: 1, deny: 1 },
  });
});

it.each([
  [`prefix-${"x".repeat(100)}`, `prefix-${"x".repeat(70)}...`],
  [`${"x".repeat(76)}\u{1f600}tail`, `${"x".repeat(76)}...`],
  [`${"x".repeat(75)}\u{1f600}tail`, `${"x".repeat(75)}\u{1f600}...`],
])(
  "limits audit output and truncates %s without exposing private fields",
  async (reason, truncated) => {
    await seedAudit({}, { agentId: "agent-b", slug: "beta", reason, outcome: "approved" });
    expect(await runJson(["audit", "--limit", "1"])).toEqual([
      {
        timestamp: "1970-01-01T00:00:02.000Z",
        agent: "agent-b",
        slug: "beta",
        outcome: "approved",
        reason: truncated,
      },
    ]);
  },
);

it.each(["0", "1.5", "1e3", "1001"])("rejects invalid audit limits: %j", async (limit) => {
  const entries = vi.spyOn(auditStore, "entries");
  await expect(run(["audit", "--limit", limit])).rejects.toThrow(
    "--limit must be an integer from 1 to 1000",
  );
  expect(entries).not.toHaveBeenCalled();
  expect(output).toBe("");
});

it("accepts the maximum decimal audit limit", async () => {
  expect(await runJson(["audit", "--limit", "1000"])).toEqual([]);
});
