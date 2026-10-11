import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWikiCli } from "./cli.js";
import {
  resolveMemoryWikiAgentConfig,
  type MemoryWikiPluginConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;
let stdoutWriteMock: ReturnType<typeof vi.fn>;

describe("memory-wiki agent-scoped cli", () => {
  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-cli-agent-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    stdoutWriteMock = vi.fn(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(
      stdoutWriteMock as unknown as typeof process.stdout.write,
    );
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function createCliVault(options?: { config?: MemoryWikiPluginConfig }) {
    return createVault({
      prefix: "memory-wiki-cli-agent-",
      rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
      config: options?.config,
    });
  }

  function stubWikiCommandAction(program: Command, commandPath: readonly string[]) {
    let command = program.commands.find((candidate) => candidate.name() === "wiki");
    for (const name of commandPath) {
      command = command?.commands.find((candidate) => candidate.name() === name);
    }
    expect(command, `wiki ${commandPath.join(" ")} command`).toBeDefined();
    command!.action(() => {});
    return command!;
  }

  function createAgentSelectionProgram(params: {
    config: ResolvedMemoryWikiConfig;
    appConfig: OpenClawConfig;
    commandPath: readonly string[];
  }) {
    const resolveConfig = vi.fn((agentId?: string) =>
      resolveMemoryWikiAgentConfig({
        config: params.config,
        appConfig: params.appConfig,
        ...(agentId ? { agentId } : {}),
      }),
    );
    const program = new Command();
    program.name("test").enablePositionalOptions().exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerWikiCli(program, {
      config: params.config,
      getAppConfig: () => params.appConfig,
      resolveConfig,
    });
    const command = stubWikiCommandAction(program, params.commandPath);
    return { command, program, resolveConfig };
  }

  it.each<{
    label: string;
    entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>;
  }>([{ label: "multi-agent", entries: { support: {}, marketing: {} } }])(
    "gives actionable agent-selection guidance for a $label roster",
    async ({ entries }) => {
      const { config } = await createCliVault({
        config: { vault: { scope: "agent" } },
      });
      const appConfig = { agents: { entries } };
      const { program, resolveConfig } = createAgentSelectionProgram({
        config,
        appConfig,
        commandPath: ["apply", "metadata"],
      });

      await expect(
        program.parseAsync(["wiki", "apply", "metadata", "entity.alpha"], { from: "user" }),
      ).rejects.toThrow(
        "No default memory-wiki agent is configured. Pass --agent <id>, or add an agent with `openclaw agents add`.",
      );
      expect(resolveConfig).not.toHaveBeenCalled();
    },
  );

  it("runs wiki doctor against explicitly selected agent-scoped vaults", async () => {
    const { rootDir, config } = await createCliVault({
      config: { vault: { scope: "agent" } },
    });
    const appConfig = {
      agents: { entries: { support: {}, marketing: {} } },
    };
    const run = async (args: string[]) => {
      stdoutWriteMock.mockClear();
      const program = new Command();
      program.name("test").enablePositionalOptions();
      registerWikiCli(program, { config, getAppConfig: () => appConfig });
      await program.parseAsync(["wiki", ...args], { from: "user" });
      return stdoutWriteMock.mock.calls.map(([chunk]) => String(chunk)).join("");
    };

    await run(["init", "--agent", "marketing"]);
    const explicitOutput = await run(["doctor", "--agent", "marketing"]);
    await run(["init", "--agent", "support"]);
    const supportOutput = await run(["doctor", "--agent", "support"]);

    expect(explicitOutput).toContain("Wiki doctor: healthy");
    expect(explicitOutput).toContain("Vault scope: agent (marketing)");
    expect(explicitOutput).toContain(path.join(rootDir, "marketing"));
    expect(supportOutput).toContain("Wiki doctor: healthy");
    expect(supportOutput).toContain("Vault scope: agent (support)");
    expect(supportOutput).toContain(path.join(rootDir, "support"));
  });

  it("does not require an agent to probe Obsidian CLI availability", async () => {
    const { config } = await createCliVault({ config: { vault: { scope: "agent" } } });
    const appConfig = { agents: { entries: {} } };
    const { program, resolveConfig } = createAgentSelectionProgram({
      config,
      appConfig,
      commandPath: ["obsidian", "status"],
    });

    await expect(
      program.parseAsync(["wiki", "obsidian", "status"], { from: "user" }),
    ).resolves.toBeDefined();
    expect(resolveConfig).not.toHaveBeenCalled();
  });
});
