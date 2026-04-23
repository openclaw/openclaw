import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it } from "vitest";
import { parseRunbookCliJson, resolveRunbookPluginRoots } from "./runbook-cli-client.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: "runbook-memory",
    name: "Runbook Memory",
    source: "workspace",
    registrationMode: "full",
    config: {} as OpenClawPluginApi["config"],
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    resolvePath: (value: string) => value,
    registerTool: () => {},
    registerHook: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerCliBackend: () => {},
    registerProvider: () => {},
    registerSpeechProvider: () => {},
    registerMediaUnderstandingProvider: () => {},
    registerImageGenerationProvider: () => {},
    registerWebSearchProvider: () => {},
    registerInteractiveHandler: () => {},
    onConversationBindingResolved: () => {},
    registerCommand: () => {},
    registerContextEngine: () => {},
    registerMemoryPromptSection: () => {},
    registerMemoryFlushPlan: () => {},
    registerMemoryRuntime: () => {},
    registerMemoryEmbeddingProvider: () => {},
    on: () => {},
    ...overrides,
  } as OpenClawPluginApi;
}

describe("runbook memory CLI helpers", () => {
  it("parses noisy JSON stdout by suffix", () => {
    const parsed = parseRunbookCliJson('log line\n{"ok":true,"items":[1,2]}\n');
    expect(parsed).toEqual({ ok: true, items: [1, 2] });
  });

  it("resolves repo-relative defaults from the extension root", () => {
    const roots = resolveRunbookPluginRoots(
      fakeApi({ rootDir: "/home/ebatter1/openclaw-upstream/extensions/runbook-memory" }),
    );

    expect(roots.repoRoot).toBe("/home/ebatter1/openclaw-upstream");
    expect(roots.cliPath).toBe(
      "/home/ebatter1/openclaw-upstream/runbook_memory/tools/runbook_cli.py",
    );
    expect(roots.dbPath).toBe(
      "/home/ebatter1/openclaw-upstream/runbook_memory/db/runbook_memory.sqlite3",
    );
    expect(roots.runbooksRoot).toBe("/home/ebatter1/openclaw-upstream/runbooks");
  });

  it("keeps explicit plugin config paths intact", () => {
    const api = fakeApi({
      rootDir: "/home/ebatter1/openclaw-upstream/extensions/runbook-memory",
      pluginConfig: {
        pythonPath: "/opt/python3",
        cliPath: "/opt/runbook-cli.py",
        workspaceRoot: "/var/lib/openclaw",
        dbPath: "/var/lib/openclaw/runbooks.sqlite",
        runbooksRoot: "/var/lib/openclaw/runbooks",
      },
    });
    const roots = resolveRunbookPluginRoots(api);

    expect(roots.pythonPath).toBe("/opt/python3");
    expect(roots.cliPath).toBe("/opt/runbook-cli.py");
    expect(roots.workspaceRoot).toBe("/var/lib/openclaw");
    expect(roots.dbPath).toBe("/var/lib/openclaw/runbooks.sqlite");
    expect(roots.runbooksRoot).toBe("/var/lib/openclaw/runbooks");
  });
});
