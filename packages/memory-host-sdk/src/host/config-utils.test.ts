import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeConfiguredMemoryExtraPaths,
  resolveMemoryHostAgentWorkspaceDir,
  resolveRememberAcrossConversations,
  type OpenClawConfig,
} from "./config-utils.js";

describe("resolveMemoryHostAgentWorkspaceDir", () => {
  it.each([{ name: "explicit profile state directory", stateDir: "/home/fixture/.openclaw-work" }])(
    "uses the active profile workspace with $name",
    ({ stateDir }) => {
      expect(
        resolveMemoryHostAgentWorkspaceDir({}, "main", {
          HOME: "/home/fixture",
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: stateDir,
        }),
      ).toBe(path.resolve("/home/fixture/.openclaw-work/workspace"));
    },
  );

  it.each([{ agentId: "main", override: "workspace", leaf: "" }])(
    "resolves the absolute $override override for $agentId without home or cwd",
    ({ agentId, override, leaf }) => {
      const absolute = path.resolve("/srv/fixture-override");
      const expected = path.join(absolute, leaf);
      const homedir = vi.spyOn(os, "homedir").mockImplementation(() => {
        throw new Error("fixture home unavailable");
      });
      const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
        throw new Error("ENOENT: fixture cwd unavailable");
      });
      try {
        expect(
          resolveMemoryHostAgentWorkspaceDir(
            { agents: { entries: { main: {}, support: {} } } },
            agentId,
            {
              OPENCLAW_HOME: "~/oc",
              OPENCLAW_STATE_DIR: override === "state" ? absolute : "~/state",
              OPENCLAW_WORKSPACE_DIR: override === "workspace" ? absolute : undefined,
            },
          ),
        ).toBe(expected);
      } finally {
        cwd.mockRestore();
        homedir.mockRestore();
      }
    },
  );

  it("uses canonical workspaces even when only the legacy state directory exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-state-"));
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, support: {} } } };
    const env = { HOME: home };
    const legacy = path.join(home, ".clawdbot");
    const current = path.join(home, ".openclaw");
    try {
      await fs.mkdir(legacy);
      expect(resolveMemoryHostAgentWorkspaceDir(cfg, "support", env)).toBe(
        path.join(current, "workspace-support"),
      );
      expect(resolveMemoryHostAgentWorkspaceDir(cfg, "main", env)).toBe(
        path.join(current, "workspace"),
      );
      expect(
        resolveMemoryHostAgentWorkspaceDir(cfg, "support", {
          ...env,
          VITEST: "1",
          OPENCLAW_TEST_FAST: "1",
        }),
      ).toBe(path.join(current, "workspace-support"));
      await fs.mkdir(current);
      expect(resolveMemoryHostAgentWorkspaceDir(cfg, "support", env)).toBe(
        path.join(current, "workspace-support"),
      );
      expect(
        resolveMemoryHostAgentWorkspaceDir(cfg, "support", {
          ...env,
          OPENCLAW_STATE_DIR: path.join(home, "override"),
        }),
      ).toBe(path.join(home, "override", "workspace-support"));
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each<{
    name: string;
    agents: NonNullable<OpenClawConfig["agents"]>;
    expected: Record<string, string>;
  }>([
    {
      name: "keyed first-agent inheritance",
      agents: { entries: { main: {}, support: {} } },
      expected: { main: "shared", support: "shared/support" },
    },
    {
      name: "explicit secondary workspace ownership",
      agents: {
        ownership: "explicit",
        entries: { first: {}, support: { workspace: "~/shared" } },
      },
      expected: { first: "shared/first", support: "shared" },
    },
  ])("preserves $name", ({ agents, expected }) => {
    const cfg: OpenClawConfig = {
      agents: { ...agents, defaults: { workspace: "~/shared" } },
    };
    for (const [agentId, relativePath] of Object.entries(expected)) {
      expect(resolveMemoryHostAgentWorkspaceDir(cfg, agentId, { HOME: "/home/fixture" })).toBe(
        path.resolve("/home/fixture", relativePath),
      );
    }
  });
});

describe("resolveRememberAcrossConversations", () => {
  it("honors keyed per-agent memory overrides", () => {
    const config = {
      memory: { search: { rememberAcrossConversations: true } },
      agents: {
        entries: {
          support: { memory: { search: { rememberAcrossConversations: false } } },
        },
      },
    };

    expect(resolveRememberAcrossConversations(config, "support")).toBe(false);
  });
});

describe("normalizeConfiguredMemoryExtraPaths", () => {
  it("preserves distinct patterns and canonicalizes unpatterned objects", () => {
    expect(
      normalizeConfiguredMemoryExtraPaths([
        " notes ",
        { path: "notes" },
        { path: " notes ", pattern: " runbooks/**/*.md " },
        { path: "notes", pattern: "runbooks/**/*.md" },
        { path: "notes", pattern: "decisions/**/*.md" },
      ]),
    ).toEqual([
      "notes",
      { path: "notes", pattern: "runbooks/**/*.md" },
      { path: "notes", pattern: "decisions/**/*.md" },
    ]);
  });
});
