import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
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

  it("includes composio-apps skill path and MCP tool preference", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(
      path.join(workspaceDir, "skills", "composio-apps", "SKILL.md"),
    );
    expect(prompt).toContain("Composio MCP");
    expect(prompt).toContain("Never");
    expect(prompt).toContain("composio_resolve_tool");
  });

  it("teaches the agent to emit direct composio connect links for any app", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("ANY third-party app or service");
    expect(prompt).toContain("always call `composio_resolve_tool`");
    expect(prompt).toContain("action_link_markdown");
    expect(prompt).toContain("MUST end the assistant reply with that exact markdown link");
    expect(prompt).toContain("dench://composio/connect");
    expect(prompt).toContain("dench://composio/reconnect");
    expect(prompt).toContain("connect_required");
  });

  it("includes enrichment guidance for Apollo and Exa", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("default tool for enrichment requests");
    expect(prompt).toContain('`action: "people"`');
    expect(prompt).toContain('`action: "company"`');
    expect(prompt).toContain('`action: "people_search"`');
    expect(prompt).toContain("Use Apollo for structured CRM enrichment and Exa for broader web research");
  });

  it("prefers Composio over gog even without a generated tool index", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("Composio is the default integration layer");
    expect(prompt).toContain("Never use `gog`");
    expect(prompt).toContain("If Composio MCP is unavailable in this session, stop");
    expect(prompt).toContain("GMAIL_FETCH_EMAILS");
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

describe("buildIdentityPrompt composio-tool-index", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes Gmail tool names from composio-tool-index.json so the agent skips catalog discovery", () => {
    tmp = path.join(
      os.tmpdir(),
      `dench-identity-composio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2026-04-01T00:00:00.000Z",
        connected_apps: [
          {
            toolkit_slug: "gmail",
            toolkit_name: "Gmail",
            account_count: 1,
            tools: [
              {
                name: "GMAIL_FETCH_EMAILS",
                title: "Fetch emails",
                description_short: "List inbox messages.",
                required_args: [],
                arg_hints: {
                  label_ids: 'Use ["INBOX"] as JSON array.',
                },
              },
            ],
            recipes: { "Read recent emails": "GMAIL_FETCH_EMAILS" },
          },
        ],
      }),
      "utf-8",
    );

    const prompt = buildIdentityPrompt(tmp);
    expect(prompt).toContain("Connected App Tools (via Composio MCP)");
    expect(prompt).toContain("GMAIL_FETCH_EMAILS");
    expect(prompt).toContain("Read recent emails");
    expect(prompt).toContain("label_ids");
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

  it("registers the Composio resolver tool when the managed skill exists", () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-register-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(path.join(tmp, "skills", "composio-apps"), { recursive: true });
    writeFileSync(
      path.join(tmp, "skills", "composio-apps", "SKILL.md"),
      "# Composio connected apps\n",
      "utf-8",
    );

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    expect(api.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "composio_resolve_tool" }),
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves recent GitHub PR requests through recipe-backed tools outside the direct tool slice", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2026-04-03T00:00:00.000Z",
        connected_apps: [
          {
            toolkit_slug: "github",
            toolkit_name: "GitHub",
            account_count: 1,
            tools: [
              {
                name: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
                title: "List repositories",
                description_short: "Lists repositories for the authenticated user.",
                required_args: [],
                arg_hints: {},
              },
            ],
            recipes: {
              "Find pull requests": "GITHUB_FIND_PULL_REQUESTS",
            },
          },
        ],
      }),
      "utf-8",
    );

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const resolver = api.registerTool.mock.calls[0][0];
    const result = await resolver.execute({
      app: "github",
      intent: "check my recent PRs",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.tool).toBe("GITHUB_FIND_PULL_REQUESTS");
    expect(payload.directly_callable).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a direct connect link when the requested app is not connected", async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dench-identity-resolver-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2026-04-03T00:00:00.000Z",
        connected_apps: [
          {
            toolkit_slug: "github",
            toolkit_name: "GitHub",
            account_count: 1,
            tools: [],
            recipes: {},
          },
        ],
      }),
      "utf-8",
    );

    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: tmp } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    const resolver = api.registerTool.mock.calls[0][0];
    const result = await resolver.execute({
      app: "slack",
      intent: "check my slack",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.availability).toBe("connect_required");
    expect(payload.action_required).toBe("connect");
    expect(payload.toolkit_slug).toBe("slack");
    expect(payload.action_link_markdown).toBe("[Connect Slack](dench://composio/connect?toolkit=slack&name=Slack)");

    rmSync(tmp, { recursive: true, force: true });
  });
});
