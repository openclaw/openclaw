import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { declareAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import * as memoryIndexing from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import * as memoryStorage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { defaultRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  firstWrittenJsonArg,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemoryCli } from "./cli.js";

const config = vi.hoisted(() => ({ current: {} as OpenClawConfig }));

// mock-isolation: Supply only synthetic configuration; discovery, reads, chunking and CLI are real.
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => config.current,
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
const policy = "- Refunds are available within thirty days. Custom-made items are excluded.";
let workspace = "";

beforeEach(async () => {
  const root = roots.make("openclaw-memory-duplicates-");
  workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  config.current = {
    agents: { entries: { main: { workspace } } },
    memory: { search: { provider: "none" } },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

async function write(relative: string, text: string) {
  const target = path.join(workspace, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerMemoryCli(program);
  await program.parseAsync(["memory", "duplicates", ...args], { from: "user" });
}

type Report = {
  agentId: string;
  filesScanned: number;
  duplicateGroupCount: number;
  duplicateOccurrenceCount: number;
  omittedGroups: number;
  groups: Array<{
    occurrences: number;
    omittedLocations: number;
    locations: Array<{ path: string; startLine: number; endLine: number }>;
  }>;
};

describe("memory duplicates CLI", () => {
  it("finds exact repeats across files and within a file, without printing text or changing sources", async () => {
    const originals = {
      "MEMORY.md": `# Policy\n\n${policy}\n\n${policy}\n`,
      "memory/shop.md": `${policy}\r\n`,
      "memory/changed.md": `${policy.replace("thirty", "seven")}\n`,
    };
    for (const [file, text] of Object.entries(originals)) {
      await write(file, text);
    }
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json", "--min-chars", "20");
    expect(firstWrittenJsonArg<Report>(json)).toEqual({
      agentId: "main",
      filesScanned: 3,
      skippedFiles: 0,
      minChars: 20,
      duplicateGroupCount: 1,
      duplicateOccurrenceCount: 3,
      omittedGroups: 0,
      groups: [
        {
          occurrences: 3,
          omittedLocations: 0,
          locations: [
            { path: "MEMORY.md", startLine: 3, endLine: 4 },
            { path: "MEMORY.md", startLine: 5, endLine: 5 },
            { path: "memory/shop.md", startLine: 1, endLine: 1 },
          ],
        },
      ],
    });
    expect(JSON.stringify(firstWrittenJsonArg(json))).not.toContain("Refunds");
    for (const [file, text] of Object.entries(originals)) {
      expect(await fs.readFile(path.join(workspace, file), "utf8")).toBe(text);
    }
  });

  it("uses configured Markdown paths without including unrelated files, sessions or symlink roots", async () => {
    await write("memory/a.md", policy);
    await write("memory/a.txt", policy);
    await write("private.md", policy);
    await write("sessions/session.md", policy);
    await write("docs/policy.md", policy);
    await write("linked/hidden.md", policy);
    await fs.symlink(path.join(workspace, "linked"), path.join(workspace, "memory", "link"), "dir");
    config.current.memory = { search: { extraPaths: ["docs", "memory/link"] } };
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json", "--min-chars", "1");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      filesScanned: 2,
      duplicateGroupCount: 1,
      groups: [
        {
          locations: [
            { path: "docs/policy.md", startLine: 1, endLine: 1 },
            { path: "memory/a.md", startLine: 1, endLine: 1 },
          ],
        },
      ],
    });
  });

  it("honors agent selection and character thresholds with an explicit empty result", async () => {
    await write("memory/a.md", policy);
    await write("memory/b.md", policy);
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({ duplicateGroupCount: 0, groups: [] });
    json.mockClear();
    config.current.agents = {
      entries: {
        main: { workspace },
        ops: { workspace: path.join(workspace, "ops") },
      },
    };
    await run("--json", "--agent", "ops", "--min-chars", "1");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      agentId: "ops",
      filesScanned: 0,
      groups: [],
    });
  });

  it("reports capped groups and locations without understating the total", async () => {
    for (let index = 0; index < 22; index += 1) {
      await write(
        `memory/${String(index).padStart(2, "0")}.md`,
        `${policy}\n- Separate recurring fact.`,
      );
    }
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json", "--min-chars", "1", "--max-groups", "1");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      duplicateGroupCount: 2,
      duplicateOccurrenceCount: 44,
      omittedGroups: 1,
      groups: [{ occurrences: 22, omittedLocations: 2 }],
    });
    expect(firstWrittenJsonArg<Report>(json)?.groups[0]?.locations).toHaveLength(20);
  });

  it("prints source locations, but no memory text, in human output", async () => {
    await write("memory/a.md", policy);
    await write("memory/b.md", policy);
    const log = spyRuntimeLogs(defaultRuntime);
    await run("--min-chars", "1");
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("1 groups in 2 files");
    expect(output).toContain("memory/a.md:1-1");
    expect(output).not.toContain("Refunds");
  });

  it("does not report identical size fragments from the same source line as separate occurrences", async () => {
    await write("memory/long.md", "a".repeat(8_000));
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({ duplicateGroupCount: 0, groups: [] });
  });

  it("does not resolve embedding SecretRefs for file-only diagnostics", async () => {
    config.current.memory = {
      search: {
        remote: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "SYNTHETIC_UNSET_EMBEDDING_KEY",
          },
        },
      },
    };
    await write("memory/a.md", policy);
    const json = spyRuntimeJson(defaultRuntime);
    await run("--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({ filesScanned: 1, groups: [] });
  });

  it.each([false, true])(
    "refuses a configured remote workspace instead of scanning a local copy (stale=%s)",
    async (stale) => {
      if (stale) {
        await write("memory/a.md", policy);
        await write("memory/b.md", policy);
      } else {
        await fs.rm(workspace, { recursive: true });
      }
      config.current.plugins = {
        entries: {
          "file-transfer": {
            config: {
              workspaces: {
                main: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" },
              },
            },
          },
        },
      };
      const json = spyRuntimeJson(defaultRuntime);
      await expect(run("--json")).rejects.toThrow("memory duplicates requires a local workspace");
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("rejects a remote mapping for another agent sharing the selected workspace", async () => {
    config.current.agents = { entries: { main: { workspace }, ops: { workspace } } };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    await expect(run("--agent", "main", "--json")).rejects.toThrow(
      "memory duplicates requires a local workspace",
    );
  });

  it("rejects a configured remote workspace alias when every default memory root is absent", async () => {
    await fs.rmdir(path.join(workspace, "memory"));
    const alias = path.join(roots.make("openclaw-memory-empty-alias-"), "alias");
    await fs.symlink(workspace, alias, "dir");
    config.current.agents = {
      entries: { main: { workspace: alias }, ops: { workspace } },
    };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    const json = spyRuntimeJson(defaultRuntime);
    await expect(run("--agent", "main", "--json")).rejects.toMatchObject({
      code: "WORKSPACE_ACCESS_UNAVAILABLE",
    });
    expect(json).not.toHaveBeenCalled();
  });

  it("does not block a local workspace because another agent has a different remote workspace", async () => {
    config.current.agents = {
      entries: { main: { workspace }, ops: { workspace: path.join(workspace, "ops") } },
    };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    const json = spyRuntimeJson(defaultRuntime);
    await run("--agent", "main", "--json");
    expect(firstWrittenJsonArg<Report>(json)).toMatchObject({
      agentId: "main",
      filesScanned: 0,
      groups: [],
    });
  });

  it.each([
    {
      name: "extra directory inside a remote workspace",
      remote: "../remote",
      extra: "../remote/memory",
    },
    {
      name: "extra file inside a remote workspace",
      remote: "../remote",
      extra: "../remote/memory/a.md",
    },
    {
      name: "recursive extra directory containing a remote workspace",
      remote: "docs/remote",
      extra: "docs",
    },
    { name: "remote subtree inside memory", remote: "memory/ops", extra: undefined },
    { name: "selected workspace inside a remote workspace", remote: "..", extra: undefined },
  ])("refuses $name before returning a local report", async ({ remote, extra }) => {
    await write("memory/local.md", policy);
    await write(path.join(remote, "memory/a.md"), policy);
    config.current.agents = {
      entries: {
        main: { workspace },
        ops: { workspace: path.resolve(workspace, remote) },
      },
    };
    config.current.memory = { search: { extraPaths: extra ? [extra] : [] } };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    const json = spyRuntimeJson(defaultRuntime);
    await expect(run("--agent", "main", "--json", "--min-chars", "1")).rejects.toMatchObject({
      code: "WORKSPACE_ACCESS_UNAVAILABLE",
    });
    expect(json).not.toHaveBeenCalled();
  });

  it.each(["docs/ops", "memory-ops"])(
    "keeps the unscanned remote directory %s from blocking local memory",
    async (remote) => {
      await write("memory/local.md", policy);
      await write(path.join(remote, "memory/a.md"), policy);
      config.current.agents = {
        entries: {
          main: { workspace },
          ops: { workspace: path.resolve(workspace, remote) },
        },
      };
      config.current.plugins = {
        entries: {
          "file-transfer": {
            config: {
              workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
            },
          },
        },
      };
      const json = spyRuntimeJson(defaultRuntime);
      await run("--agent", "main", "--json", "--min-chars", "1");
      expect(firstWrittenJsonArg<Report>(json)).toMatchObject({ filesScanned: 1, groups: [] });
    },
  );

  it("refuses a patterned extra root that overlaps a remote workspace", async () => {
    config.current.agents = {
      entries: {
        main: { workspace },
        ops: { workspace: path.join(workspace, "docs/ops") },
      },
    };
    config.current.memory = { search: { extraPaths: [{ path: "docs", pattern: "**/*.md" }] } };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    await expect(run("--agent", "main", "--json")).rejects.toMatchObject({
      code: "WORKSPACE_ACCESS_UNAVAILABLE",
    });
  });

  it("rejects an extra path with a symlinked parent pointing into a mapped remote root", async () => {
    const remote = path.resolve(workspace, "../remote");
    await write("memory/local.md", policy);
    await write("../remote/memory/copied.md", policy);
    await fs.symlink(remote, path.join(workspace, "alias"), "dir");
    config.current.agents = { entries: { main: { workspace }, ops: { workspace: remote } } };
    config.current.memory = { search: { extraPaths: ["alias/memory"] } };
    config.current.plugins = {
      entries: {
        "file-transfer": {
          config: {
            workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
          },
        },
      },
    };
    await expect(run("--agent", "main", "--json")).rejects.toMatchObject({
      code: "WORKSPACE_ACCESS_UNAVAILABLE",
    });
  });

  it.each(["alias/missing/nested", "alias/missing/policy.md"])(
    "rejects missing remote root %s through an existing symlinked parent",
    async (extra) => {
      const remote = path.resolve(workspace, "../remote");
      await fs.mkdir(remote);
      await write("memory/local.md", policy);
      await fs.symlink(remote, path.join(workspace, "alias"), "dir");
      config.current.agents = { entries: { main: { workspace }, ops: { workspace: remote } } };
      config.current.memory = { search: { extraPaths: [extra] } };
      config.current.plugins = {
        entries: {
          "file-transfer": {
            config: {
              workspaces: { ops: { nodeId: "synthetic-node", remoteRoot: "/synthetic/workspace" } },
            },
          },
        },
      };
      const json = spyRuntimeJson(defaultRuntime);
      await expect(run("--agent", "main", "--json")).rejects.toMatchObject({
        code: "WORKSPACE_ACCESS_UNAVAILABLE",
      });
      expect(json).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(workspace, "memory/local.md"), "utf8")).toBe(policy);
    },
  );

  it.each([
    { relative: "memory", alias: false },
    { relative: "docs", alias: false },
    { relative: "memory", alias: true },
  ])(
    "rejects declared ownership nested below $relative before reading files (alias: $alias)",
    async ({ relative, alias }) => {
      const staleFile = path.join(relative, "remote/policy.md");
      await write(staleFile, policy);
      declareAgentWorkspaceAccess(path.join(workspace, relative, "remote"));
      let selectedWorkspace = workspace;
      if (alias) {
        selectedWorkspace = path.join(roots.make("openclaw-memory-nested-alias-"), "alias");
        await fs.symlink(workspace, selectedWorkspace, "dir");
      }
      config.current.agents = { entries: { main: { workspace: selectedWorkspace } } };
      config.current.memory = { search: { extraPaths: relative === "docs" ? [relative] : [] } };
      // mock-isolation: Passthrough spies prove admission precedes the real reader and chunker.
      const read = vi.spyOn(memoryStorage, "readMemoryFile");
      const chunk = vi.spyOn(memoryIndexing, "chunkMarkdown");
      const json = spyRuntimeJson(defaultRuntime);
      await expect(run("--json")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_UNAVAILABLE" });
      expect(read).not.toHaveBeenCalled();
      expect(chunk).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(workspace, staleFile), "utf8")).toBe(policy);
    },
  );

  it.each(["memory", "docs"])(
    "honors declared unavailable ownership of the %s scan root",
    async (relative) => {
      const scanRoot = path.join(workspace, relative);
      declareAgentWorkspaceAccess(scanRoot);
      config.current.memory = { search: { extraPaths: [relative] } };
      await expect(run("--json")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_UNAVAILABLE" });
    },
  );

  it.each([
    { relative: "memory", exists: false, alias: "none" },
    { relative: "docs", exists: false, alias: "none" },
    { relative: "memory", exists: true, alias: "none" },
    { relative: "docs", exists: true, alias: "none" },
    { relative: "memory", exists: false, alias: "scan" },
    { relative: "docs", exists: false, alias: "owner" },
  ])(
    "rejects declared empty remote descendants before discovery: $relative, exists=$exists, alias=$alias",
    async ({ relative, exists, alias }) => {
      const scanRoot = path.join(workspace, relative);
      await fs.mkdir(scanRoot, { recursive: true });
      const declared = path.join(scanRoot, "remote");
      if (exists) {
        await fs.mkdir(declared);
      }
      let selectedWorkspace = workspace;
      let declaredRoot = declared;
      if (alias === "scan") {
        selectedWorkspace = path.join(roots.make("openclaw-memory-empty-scan-alias-"), "alias");
        await fs.symlink(workspace, selectedWorkspace, "dir");
      } else if (alias === "owner") {
        const ownerAlias = path.join(roots.make("openclaw-memory-empty-owner-alias-"), "alias");
        await fs.symlink(scanRoot, ownerAlias, "dir");
        declaredRoot = path.join(ownerAlias, "remote");
      }
      declareAgentWorkspaceAccess(declaredRoot);
      config.current.agents = { entries: { main: { workspace: selectedWorkspace } } };
      config.current.memory = { search: { extraPaths: relative === "docs" ? [relative] : [] } };
      // mock-isolation: Passthrough observation verifies refusal before filesystem discovery.
      const discover = vi.spyOn(memoryStorage, "listMemoryFiles");
      const json = spyRuntimeJson(defaultRuntime);
      await expect(run("--json")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_UNAVAILABLE" });
      expect(discover).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("respects a declared but unavailable workspace owner", async () => {
    await write("memory/a.md", policy);
    await write("memory/b.md", policy);
    declareAgentWorkspaceAccess(workspace);
    const json = spyRuntimeJson(defaultRuntime);
    await expect(run("--json")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_UNAVAILABLE" });
    expect(json).not.toHaveBeenCalled();
  });

  it("honors unavailable workspace ownership through a symlinked parent alias", async () => {
    await write("memory/local.md", policy);
    declareAgentWorkspaceAccess(workspace);
    const alias = path.join(roots.make("openclaw-memory-alias-"), "alias");
    await fs.symlink(path.dirname(workspace), alias, "dir");
    config.current.agents = { entries: { main: { workspace: path.join(alias, "workspace") } } };
    await expect(run("--json")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_UNAVAILABLE" });
  });

  it("honors declared ownership above an extra memory subdirectory", async () => {
    const remote = path.resolve(workspace, "../remote");
    await write("../remote/memory/copied.md", policy);
    declareAgentWorkspaceAccess(remote);
    config.current.memory = { search: { extraPaths: [path.join(remote, "memory")] } };
    await expect(run("--json")).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_UNAVAILABLE" });
  });

  it("reports disabled memory and refuses another plugin's memory slot", async () => {
    const json = spyRuntimeJson(defaultRuntime);
    config.current.memory = { search: { enabled: false } };
    await run("--json");
    expect(firstWrittenJsonArg(json)).toEqual({ agentId: "main", status: "disabled" });
    config.current.plugins = { slots: { memory: "knowledge" } };
    await expect(run("--json")).rejects.toThrow(
      "memory slot selects \"knowledge\". Use the knowledge plugin's own commands or the agent's memory tools.",
    );
  });

  it.each(["--min-chars", "--max-groups"])(
    "rejects nonpositive %s before scanning",
    async (flag) => {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerMemoryCli(program);
      await expect(
        program.parseAsync(["memory", "duplicates", flag, "0"], { from: "user" }),
      ).rejects.toMatchObject({ code: "commander.invalidArgument" });
    },
  );
});
