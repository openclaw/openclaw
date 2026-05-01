import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexEnabledConfig,
  formatCodexRoutes,
  registerCodexGatewayMethods,
  registerCodexNativeCommand,
} from "./commands.js";
import { resolveCodexSdkPluginConfig } from "./config.js";

const tempDirs: string[] = [];
type TestGatewayHandler = (opts: Record<string, unknown>) => unknown;

async function createApi(): Promise<{
  api: OpenClawPluginApi;
  commands: unknown[];
  methods: Map<string, TestGatewayHandler>;
  writeConfigFile: ReturnType<typeof vi.fn>;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-sdk-commands-test-"));
  tempDirs.push(stateDir);
  const commands: unknown[] = [];
  const methods = new Map<string, TestGatewayHandler>();
  const writeConfigFile = vi.fn(async () => {});
  return {
    commands,
    methods,
    writeConfigFile,
    api: {
      id: "codex-sdk",
      name: "Codex SDK Runtime",
      source: "/tmp/codex-sdk/index.ts",
      config: {},
      pluginConfig: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      runtime: {
        state: { resolveStateDir: () => stateDir },
        config: {
          loadConfig: () => ({}),
          writeConfigFile,
        },
      },
      registerCommand: (command: unknown) => commands.push(command),
      registerGatewayMethod: (method: string, handler: TestGatewayHandler) =>
        methods.set(method, handler),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerChannel: vi.fn(),
      registerProvider: vi.fn(),
      registerContextEngine: vi.fn(),
      resolvePath: (input: string) => input,
      on: vi.fn(),
    } as unknown as OpenClawPluginApi,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("codex-sdk commands", () => {
  it("builds config that makes codex-sdk the OpenClaw ACP backend", () => {
    const pluginConfig = resolveCodexSdkPluginConfig({
      rawConfig: {
        routes: {
          plan: { aliases: ["codex-plan"] },
        },
      },
    });
    const next = buildCodexEnabledConfig(
      {
        acp: { backend: "acpx", stream: { deliveryMode: "final_only" } },
        plugins: { entries: { "codex-sdk": { config: { model: "gpt-5.4" } } } },
      },
      pluginConfig,
    );

    expect(next.acp).toMatchObject({
      enabled: true,
      dispatch: { enabled: true },
      backend: "codex-sdk",
      defaultAgent: "codex",
      stream: { deliveryMode: "final_only" },
    });
    expect(next.acp?.allowedAgents).toEqual(expect.arrayContaining(["codex", "codex-plan"]));
    expect(next.plugins?.entries?.["codex-sdk"]).toMatchObject({
      enabled: true,
      config: { model: "gpt-5.4" },
    });
    expect(next.agents?.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex",
          runtime: {
            type: "acp",
            acp: expect.objectContaining({
              agent: "codex",
              backend: "codex-sdk",
              mode: "persistent",
            }),
          },
        }),
      ]),
    );
  });

  it("registers a slash command and gateway methods against the same controller surface", async () => {
    const { api, commands, methods } = await createApi();

    registerCodexNativeCommand(api);
    registerCodexGatewayMethods(api);

    expect(commands).toHaveLength(1);
    expect(methods.has("codex.status")).toBe(true);
    expect(methods.has("codex.routes")).toBe(true);
    expect(methods.has("codex.events")).toBe(true);
    expect(methods.has("codex.session.export")).toBe(true);
    expect(methods.has("codex.proposal.create")).toBe(true);
    expect(methods.has("codex.proposal.execute")).toBe(true);

    const command = commands[0] as {
      name: string;
      handler: (ctx: {
        args?: string;
        channel: string;
        isAuthorizedSender: boolean;
        commandBody: string;
        config: object;
      }) => Promise<{ text: string }>;
    };
    expect(command.name).toBe("codex");
    await expect(
      command.handler({
        args: "routes",
        channel: "test",
        isAuthorizedSender: true,
        commandBody: "/codex routes",
        config: {},
      }),
    ).resolves.toEqual({
      text: expect.stringContaining("codex/deep"),
    });

    const respond = vi.fn();
    await methods.get("codex.routes")?.({
      params: {},
      respond,
      req: { type: "req", id: "1", method: "codex.routes" },
      client: null,
      isWebchatConnect: () => false,
      context: {},
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        routes: expect.arrayContaining([expect.objectContaining({ label: "codex/deep" })]),
      }),
      undefined,
    );

    const createRespond = vi.fn();
    await methods.get("codex.proposal.create")?.({
      params: {
        title: "Backchannel follow-up",
        summary: "Created through MCP.",
        actions: ["review"],
      },
      respond: createRespond,
      req: { type: "req", id: "2", method: "codex.proposal.create" },
      client: null,
      isWebchatConnect: () => false,
      context: {},
    });
    expect(createRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        title: "Backchannel follow-up",
        status: "new",
      }),
      undefined,
    );
  });

  it("formats route details for operator-readable surfaces", () => {
    expect(
      formatCodexRoutes([
        {
          id: "deep",
          label: "codex/deep",
          aliases: ["codex-deep"],
          modelReasoningEffort: "high",
          sandboxMode: "workspace-write",
        },
      ]),
    ).toContain("codex/deep (reasoning=high, sandbox=workspace-write)");
  });
});
