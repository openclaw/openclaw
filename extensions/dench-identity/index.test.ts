import { describe, it, expect, vi } from "vitest";
import { buildIdentityPrompt, resolveWorkspaceDir } from "./index.ts";
import register from "./index.ts";
import path from "node:path";

describe("buildIdentityPrompt", () => {
  const workspaceDir = "/home/user/workspace";

  it("includes chat history path so agent can reference past conversations", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(".openclaw/web-chat/");
    expect(prompt).toContain(
      path.join(workspaceDir, ".openclaw/web-chat/"),
    );
  });

  it("includes all workspace context paths (prevents agent losing orientation)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(`**Root**: \`${workspaceDir}\``);
    expect(prompt).toContain(path.join(workspaceDir, "workspace.duckdb"));
    expect(prompt).toContain(path.join(workspaceDir, "skills"));
    expect(prompt).toContain(path.join(workspaceDir, "apps"));
  });

  it("includes CRM skill path for delegation (prevents agent using wrong skill path)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(
      path.join(workspaceDir, "skills", "crm", "SKILL.md"),
    );
  });

  it("does not advertise the removed browser skill contract", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).not.toContain(
      path.join(workspaceDir, "skills", "browser", "SKILL.md"),
    );
    expect(prompt).not.toContain("Browser Agent");
  });

  it("includes exec approval policy (prevents agent stalling on exec confirmation)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("elevated: true");
    expect(prompt).toContain("automatically approved");
  });

  it("references DenchClaw branding, not OpenClaw (prevents identity confusion)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("You are **DenchClaw**");
    expect(prompt).toContain("always use **DenchClaw** (not OpenClaw)");
  });
});

describe("resolveWorkspaceDir", () => {
  it("returns workspace path when config is a valid string", () => {
    const api = { config: { agents: { defaults: { workspace: "/home/user/ws" } } } };
    expect(resolveWorkspaceDir(api)).toBe("/home/user/ws");
  });

  it("returns undefined when api is null (prevents crash on missing config)", () => {
    expect(resolveWorkspaceDir(null)).toBeUndefined();
  });

  it("returns undefined when api is undefined (prevents crash on missing config)", () => {
    expect(resolveWorkspaceDir(undefined)).toBeUndefined();
  });

  it("returns undefined when config chain is missing (prevents crash on partial config)", () => {
    expect(resolveWorkspaceDir({})).toBeUndefined();
    expect(resolveWorkspaceDir({ config: {} })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: {} } })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: { defaults: {} } } })).toBeUndefined();
  });

  it("returns undefined when workspace is empty string (prevents empty path injection)", () => {
    const api = { config: { agents: { defaults: { workspace: "" } } } };
    expect(resolveWorkspaceDir(api)).toBeUndefined();
  });

  it("returns undefined when workspace is whitespace-only (prevents whitespace path injection)", () => {
    const api = { config: { agents: { defaults: { workspace: "   " } } } };
    expect(resolveWorkspaceDir(api)).toBeUndefined();
  });

  it("returns undefined when workspace is not a string (prevents type coercion)", () => {
    expect(resolveWorkspaceDir({ config: { agents: { defaults: { workspace: 42 } } } })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: { defaults: { workspace: true } } } })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: { defaults: { workspace: null } } } })).toBeUndefined();
  });

  it("trims leading/trailing whitespace from valid paths", () => {
    const api = { config: { agents: { defaults: { workspace: "  /home/user/ws  " } } } };
    expect(resolveWorkspaceDir(api)).toBe("/home/user/ws");
  });
});

describe("register", () => {
  it("hooks into before_prompt_build event when enabled", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: "/ws" } } },
      on: vi.fn(),
    };
    register(api);
    expect(api.on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      { priority: 100 },
    );
  });

  it("does not register handler when plugin is explicitly disabled (respects config)", () => {
    const api = {
      config: { plugins: { entries: { "dench-identity": { config: { enabled: false } } } } },
      on: vi.fn(),
    };
    register(api);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("handler returns system context when workspace is configured", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: "/ws" } } },
      on: vi.fn(),
    };
    register(api);

    const handler = api.on.mock.calls[0][1];
    const result = handler({}, {});
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("DenchClaw"),
    });
  });

  it("handler returns undefined when workspace is not configured (prevents empty prompt)", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: {} } },
      on: vi.fn(),
    };
    register(api);

    const handler = api.on.mock.calls[0][1];
    const result = handler({}, {});
    expect(result).toBeUndefined();
  });
});
