import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ErrorCodes } from "openclaw/plugin-sdk/gateway-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type TestPluginApi = ReturnType<typeof createTestPluginApi>;
type GatewayHandler = Parameters<TestPluginApi["registerGatewayMethod"]>[1];
type GatewayMethodOptions = Parameters<TestPluginApi["registerGatewayMethod"]>[2];

const commandMocks = vi.hoisted(() => ({
  runPluginCommandWithTimeout: vi.fn(async () => ({
    code: 0,
    stdout: "setup ok",
    stderr: "",
  })),
}));

vi.mock("openclaw/plugin-sdk/sandbox", () => ({
  runPluginCommandWithTimeout: commandMocks.runPluginCommandWithTimeout,
}));

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-setup-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill({
  workspaceDir,
  relativeDir,
  frontmatter,
  scriptPath = "scripts/setup.sh",
}: {
  workspaceDir: string;
  relativeDir: string;
  frontmatter: string;
  scriptPath?: string;
}): Promise<{ skillDir: string; skillDirReal: string; scriptPathReal: string }> {
  const skillDir = path.join(workspaceDir, "skills", relativeDir);
  await fs.mkdir(path.dirname(path.join(skillDir, scriptPath)), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\n${frontmatter.trim()}\n---\n# ${path.basename(relativeDir)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(skillDir, scriptPath), "#!/usr/bin/env bash\n", "utf8");
  return {
    skillDir,
    skillDirReal: await fs.realpath(skillDir),
    scriptPathReal: await fs.realpath(path.join(skillDir, scriptPath)),
  };
}

function registerSkillsSetupPlugin({
  config,
  workspaceDir,
}: {
  config: Record<string, unknown>;
  workspaceDir: string;
}): {
  handler: GatewayHandler;
  options: GatewayMethodOptions;
  registerGatewayMethod: ReturnType<typeof vi.fn>;
} {
  void config;
  let handler: GatewayHandler | undefined;
  let options: GatewayMethodOptions;
  const registerGatewayMethod = vi.fn(
    (method: string, nextHandler: GatewayHandler, nextOptions: GatewayMethodOptions) => {
    expect(method).toBe("skills.setup");
    handler = nextHandler;
    options = nextOptions;
    },
  );
  const api = createTestPluginApi({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: vi.fn(() => workspaceDir),
      },
    } as unknown as TestPluginApi["runtime"],
    registerGatewayMethod,
  });

  plugin.register(api);
  if (!handler) {
    throw new Error("skills-setup did not register skills.setup");
  }
  return { handler, options, registerGatewayMethod };
}

async function callGatewayMethod({
  handler,
  config,
  requestParams,
}: {
  handler: GatewayHandler;
  config: Record<string, unknown>;
  requestParams: Record<string, unknown>;
}) {
  const respond = vi.fn();
  await handler({
    params: requestParams,
    respond,
    context: {
      getRuntimeConfig: () => config,
    },
  } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

beforeEach(() => {
  commandMocks.runPluginCommandWithTimeout.mockClear();
  commandMocks.runPluginCommandWithTimeout.mockResolvedValue({
    code: 0,
    stdout: "setup ok",
    stderr: "",
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("skills-setup plugin", () => {
  it("registers the admin-only skills.setup gateway method", async () => {
    const workspaceDir = await makeTempDir();
    const { options, registerGatewayMethod } = registerSkillsSetupPlugin({
      workspaceDir,
      config: {},
    });

    expect(registerGatewayMethod).toHaveBeenCalledTimes(1);
    expect(options).toEqual({ scope: "operator.admin" });
  });

  it("runs grouped skills and passes sanitized setup env", async () => {
    const workspaceDir = await makeTempDir();
    await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "skills", "demo", "README.md"), "not a skill\n");
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "team/demo",
      frontmatter: `
metadata:
  openclaw:
    skillKey: team/demo
    setup:
      script: scripts/setup.sh
`,
    });
    const config = {
      plugins: {
        entries: {
          "skills-setup": {
            config: { timeoutMs: 5_000 },
          },
        },
      },
      skills: {
        entries: {
          "team/demo": {
            env: {
              API_TOKEN: "from-config",
              EXTRA: "from-config",
              HOME: "/should/not/pass",
              PATH: "/should/not/pass",
            },
          },
        },
      },
    };
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config });

    const respond = await callGatewayMethod({
      handler,
      config,
      requestParams: {
        slug: "Demo",
        env: {
          API_TOKEN: "from-request",
          CUSTOM: "from-request",
          PATH: "/request/path",
          SKILL_DIR: "/request/skill",
        },
        timeoutMs: 999_999,
      },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        API_TOKEN: "from-request",
        EXTRA: "from-config",
        CUSTOM: "from-request",
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 600_000,
    });
  });

  it("reads JSON-shaped skill metadata", async () => {
    const workspaceDir = await makeTempDir();
    const skill = await writeSkill({
      workspaceDir,
      relativeDir: "json-skill",
      scriptPath: "setup.sh",
      frontmatter: `
metadata: '{"openclaw":{"skillKey":"json-skill-key","setup":{"script":"setup.sh"}}}'
`,
    });
    const config = {
      skills: {
        entries: {
          "json-skill-key": {
            env: {
              JSON_SKILL_ENV: "enabled",
            },
          },
        },
      },
    };
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config });

    const respond = await callGatewayMethod({
      handler,
      config,
      requestParams: { slug: "json-skill" },
    });

    expect(respond).toHaveBeenCalledWith(true, { code: 0, stdout: "setup ok", stderr: "" });
    expect(commandMocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: ["bash", skill.scriptPathReal],
      cwd: skill.skillDirReal,
      env: {
        JSON_SKILL_ENV: "enabled",
        SKILL_DIR: skill.skillDirReal,
      },
      timeoutMs: 120_000,
    });
  });

  it("rejects setup scripts outside the skill directory", async () => {
    const workspaceDir = await makeTempDir();
    await writeSkill({
      workspaceDir,
      relativeDir: "escape",
      frontmatter: `
metadata:
  openclaw:
    setup:
      script: ../outside.sh
`,
    });
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "escape" },
    });

    expect(commandMocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toEqual({
      error: "setup.script escapes the skill directory",
    });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
    });
  });

  it("reports invalid slugs as invalid requests", async () => {
    const workspaceDir = await makeTempDir();
    const { handler } = registerSkillsSetupPlugin({ workspaceDir, config: {} });

    const respond = await callGatewayMethod({
      handler,
      config: {},
      requestParams: { slug: "../bad" },
    });

    expect(commandMocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toEqual({
      error: "invalid skill slug",
    });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
    });
  });
});
