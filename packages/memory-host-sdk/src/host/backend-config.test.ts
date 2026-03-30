import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../../../../src/agents/agent-scope.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { resolveUserPath } from "../../../../src/utils.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

/** Mirrors `resolvePath` in `backend-config.ts` so expectations match POSIX vs Windows. */
function resolveQmdPathForTest(raw: string, cfg: OpenClawConfig, agentId: string): string {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const trimmed = raw.trim();
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return path.normalize(resolveUserPath(trimmed));
  }
  return path.normalize(path.resolve(workspaceDir, trimmed));
}

describe("resolveMemoryBackendConfig", () => {
  it("defaults to builtin backend when config missing", () => {
    const cfg = { agents: { defaults: { workspace: "/tmp/memory-test" } } } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("builtin");
    expect(resolved.citations).toBe("auto");
    expect(resolved.qmd).toBeUndefined();
  });

  it("resolves qmd backend with default collections", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("qmd");
    expect(resolved.qmd?.collections.length).toBeGreaterThanOrEqual(3);
    expect(resolved.qmd?.command).toBe("qmd");
    expect(resolved.qmd?.searchMode).toBe("search");
    expect(resolved.qmd?.update.intervalMs).toBeGreaterThan(0);
    expect(resolved.qmd?.update.waitForBootSync).toBe(false);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(30_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(120_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(120_000);
    const names = new Set((resolved.qmd?.collections ?? []).map((collection) => collection.name));
    expect(names.has("memory-root-main")).toBe(true);
    expect(names.has("memory-alt-main")).toBe(true);
    expect(names.has("memory-dir-main")).toBe(true);
  });

  it("parses quoted qmd command paths", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          command: '"/Applications/QMD Tools/qmd" --flag',
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.command).toBe("/Applications/QMD Tools/qmd");
  });

  it("resolves custom paths relative to workspace", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [{ id: "main", workspace: "/workspace/root" }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          paths: [
            {
              path: "notes",
              name: "custom-notes",
              pattern: "**/*.md",
            },
          ],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const custom = resolved.qmd?.collections.find((c) => c.name.startsWith("custom-notes"));
    expect(custom).toBeDefined();
    const workspaceRoot = resolveAgentWorkspaceDir(cfg, "main");
    expect(custom?.path).toBe(path.resolve(workspaceRoot, "notes"));
  });

  it("scopes qmd collection names per agent", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [
          { id: "main", default: true, workspace: "/workspace/root" },
          { id: "dev", workspace: "/workspace/dev" },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          paths: [{ path: "notes", name: "workspace", pattern: "**/*.md" }],
        },
      },
    } as OpenClawConfig;
    const mainResolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const devResolved = resolveMemoryBackendConfig({ cfg, agentId: "dev" });
    const mainNames = new Set(
      (mainResolved.qmd?.collections ?? []).map((collection) => collection.name),
    );
    const devNames = new Set(
      (devResolved.qmd?.collections ?? []).map((collection) => collection.name),
    );
    expect(mainNames.has("memory-dir-main")).toBe(true);
    expect(devNames.has("memory-dir-dev")).toBe(true);
    expect(mainNames.has("workspace-main")).toBe(true);
    expect(devNames.has("workspace-dev")).toBe(true);
  });

  it("resolves qmd update timeout overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          update: {
            waitForBootSync: true,
            commandTimeoutMs: 12_000,
            updateTimeoutMs: 480_000,
            embedTimeoutMs: 360_000,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.update.waitForBootSync).toBe(true);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(12_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(480_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(360_000);
  });

  it("resolves qmd search mode override", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "vsearch",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.searchMode).toBe("vsearch");
  });

  it("resolves qmd mcporter search tool override", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "query",
          searchTool: " hybrid_search ",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.searchMode).toBe("query");
    expect(resolved.qmd?.searchTool).toBe("hybrid_search");
  });
});

describe("memorySearch.extraPaths integration", () => {
  it("maps agents.defaults.memorySearch.extraPaths to QMD collections", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/home/user/docs", "/home/user/vault"],
          },
        },
      },
    } as OpenClawConfig;
    const result = resolveMemoryBackendConfig({ cfg, agentId: "test-agent" });
    expect(result.backend).toBe("qmd");
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    expect(customCollections.length).toBeGreaterThanOrEqual(2);
    expect(customCollections.map((collection) => collection.path)).toEqual(
      expect.arrayContaining([
        resolveQmdPathForTest("/home/user/docs", cfg, "test-agent"),
        resolveQmdPathForTest("/home/user/vault", cfg, "test-agent"),
      ]),
    );
  });

  it("merges default and per-agent memorySearch.extraPaths for QMD collections", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/default/path"],
          },
        },
        list: [
          {
            id: "my-agent",
            memorySearch: {
              extraPaths: ["/agent/specific/path"],
            },
          },
        ],
      },
    } as OpenClawConfig;
    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    expect(result.backend).toBe("qmd");
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    const paths = customCollections.map((collection) => collection.path);
    expect(paths).toContain(resolveQmdPathForTest("/agent/specific/path", cfg, "my-agent"));
    expect(paths).toContain(resolveQmdPathForTest("/default/path", cfg, "my-agent"));
  });

  it("falls back to defaults when agent has no overrides", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/default/path"],
          },
        },
        list: [
          {
            id: "other-agent",
            memorySearch: {
              extraPaths: ["/other/path"],
            },
          },
        ],
      },
    } as OpenClawConfig;
    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    expect(result.backend).toBe("qmd");
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    const paths = customCollections.map((collection) => collection.path);
    expect(paths).toContain(resolveQmdPathForTest("/default/path", cfg, "my-agent"));
  });

  it("deduplicates merged memorySearch.extraPaths for QMD collections", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/shared/path", " /shared/path "],
          },
        },
        list: [
          {
            id: "my-agent",
            memorySearch: {
              extraPaths: ["/shared/path", "/agent-only"],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    const paths = customCollections.map((collection) => collection.path);
    const sharedResolved = resolveQmdPathForTest("/shared/path", cfg, "my-agent");

    expect(paths.filter((collectionPath) => collectionPath === sharedResolved)).toHaveLength(1);
    expect(paths).toContain(resolveQmdPathForTest("/agent-only", cfg, "my-agent"));
  });

  it("matches per-agent memorySearch.extraPaths using normalized agent ids", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
        },
        list: [
          {
            id: "My-Agent",
            memorySearch: {
              extraPaths: ["/agent/mixed-case"],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );

    expect(customCollections.map((collection) => collection.path)).toContain(
      resolveQmdPathForTest("/agent/mixed-case", cfg, "my-agent"),
    );
  });

  it("deduplicates identical roots shared by memory.qmd.paths and memorySearch.extraPaths", () => {
    const cfg = {
      memory: {
        backend: "qmd",
        qmd: {
          paths: [{ path: "docs", pattern: "**/*.md", name: "workspace-docs" }],
        },
      },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["./docs"],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    const docsPath = resolveQmdPathForTest("./docs", cfg, "main");
    const docsCollections = customCollections.filter(
      (collection) => collection.path === docsPath && collection.pattern === "**/*.md",
    );

    expect(docsCollections).toHaveLength(1);
  });
});
