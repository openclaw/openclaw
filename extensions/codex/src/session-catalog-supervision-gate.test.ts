import { expect, it, vi } from "vitest";
import {
  createControl,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  fs,
  os,
  path,
  registerCodexSessionCatalog,
  resolveCodexAppServerHomeDir,
  tempDirs,
  withEnvAsync,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

async function registerLocalCatalog(pluginConfig: unknown) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-catalog-supervision-")),
  );
  tempDirs.push(root);
  const agentDir = path.join(root, "agents", "main", "agent");
  const processCodexHome = path.join(root, "process-codex-home");
  await Promise.all(
    [processCodexHome, resolveCodexAppServerHomeDir(agentDir)].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  const runtimeConfig = {
    agents: { ownership: "explicit", entries: { main: { agentDir } } },
  } as OpenClawConfig;
  const { runtime, createSessionEntry } = createRuntime();
  const { api, getProvider } = createGatewayApi(runtime, runtimeConfig);
  const listPage = vi.fn(async (source?: { sourceHomeId: string }) => ({
    sessions: (["idle", "notLoaded", "active"] as const).flatMap((status) =>
      ["cli", "exec"].map((kind) => ({
        threadId: `thread-${source?.sourceHomeId ?? "missing"}-${status}-${kind}`,
        status,
        source: kind,
        archived: false as const,
      })),
    ),
  }));
  registerCodexSessionCatalog({
    api,
    bindingStore: createCodexTestBindingStore(),
    control: {
      forRequest: vi.fn((_agentId: string, source?: { sourceHomeId: string }) =>
        createControl({ listPage: () => listPage(source) }),
      ),
    },
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => runtimeConfig,
  });
  const provider = getProvider()!;
  const list = () =>
    withEnvAsync({ CODEX_HOME: processCodexHome }, async () => {
      const completions: Promise<void>[] = [];
      const hosts = await provider.list({
        agentId: "main",
        listNodes: async () => ({ nodes: [] }),
        waitUntil: (completion) => {
          completions.push(completion);
        },
      });
      await Promise.all(completions);
      return hosts ?? [];
    });
  return { provider, list, createSessionEntry, processCodexHome };
}

it.each([
  { state: "absent", pluginConfig: undefined, canContinue: false },
  { state: "disabled", pluginConfig: { supervision: { enabled: false } }, canContinue: false },
  { state: "enabled", pluginConfig: { supervision: { enabled: true } }, canContinue: true },
])(
  "gates local continuation with supervision $state while preserving archive eligibility",
  async ({ pluginConfig, canContinue: expectedCanContinue }) => {
    const { list } = await registerLocalCatalog(pluginConfig);
    const hosts = await list();
    expect(hosts).toHaveLength(2);
    expect(hosts.map((host) => host.hostId)).toContain("gateway:local");
    expect(hosts.some((host) => host.hostId.startsWith("gateway:local:"))).toBe(true);
    for (const host of hosts) {
      expect(
        host.sessions.map(({ status, source, canArchive, canContinue }) => [
          status,
          source,
          canArchive,
          canContinue,
        ]),
      ).toEqual([
        ["idle", "cli", true, expectedCanContinue],
        ["idle", "exec", false, false],
        ["notLoaded", "cli", true, expectedCanContinue],
        ["notLoaded", "exec", false, false],
        ["active", "cli", false, false],
        ["active", "exec", false, false],
      ]);
    }
  },
);

it("rejects local continuation before adoption when supervision is disabled", async () => {
  const { provider, list, createSessionEntry, processCodexHome } = await registerLocalCatalog({
    supervision: { enabled: false },
  });
  const [host] = await list();
  await withEnvAsync({ CODEX_HOME: processCodexHome }, async () => {
    await expect(
      provider.continueSession!({
        agentId: "main",
        hostId: host!.hostId,
        threadId: host!.sessions[0]!.threadId,
        sourceHomeId: host!.sessions[0]!.sourceHomeId,
        clientScopes: ["operator.admin"],
      }),
    ).rejects.toThrow("Codex supervision is disabled");
  });
  expect(createSessionEntry).not.toHaveBeenCalled();
});
