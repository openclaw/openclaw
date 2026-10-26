import { expect, it } from "vitest";
import {
  createControl,
  createCatalogTestProvider,
  createRuntime,
  fs,
  os,
  path,
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
  const listPage = async () => ({
    sessions: (["idle", "notLoaded", "active"] as const).flatMap((status) =>
      ["cli", "exec"].map((kind) => ({
        threadId: `${status}-${kind}`,
        status,
        source: kind,
        archived: false as const,
      })),
    ),
  });
  const provider = createCatalogTestProvider({
    runtime,
    startupConfig: runtimeConfig,
    control: {
      forRequest: () => createControl({ listPage }),
    },
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => runtimeConfig,
  });
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
    const { provider, list, createSessionEntry, processCodexHome } =
      await registerLocalCatalog(pluginConfig);
    const hosts = await list();
    expect(hosts).toHaveLength(2);
    expect(hosts.map((host) => host.hostId)).toContain("gateway:local");
    expect(hosts.some((host) => host.hostId.startsWith("gateway:local:"))).toBe(true);
    for (const host of hosts) {
      expect(host.sessions.map(({ canArchive, canContinue }) => [canArchive, canContinue])).toEqual(
        [
          [true, expectedCanContinue],
          [false, false],
          [true, expectedCanContinue],
          [false, false],
          [false, false],
          [false, false],
        ],
      );
    }
    if (expectedCanContinue) {
      return;
    }
    const host = hosts[0]!;
    await withEnvAsync({ CODEX_HOME: processCodexHome }, async () => {
      await expect(
        provider.continueSession!({
          agentId: "main",
          hostId: host.hostId,
          threadId: host.sessions[0]!.threadId,
          sourceHomeId: host.sessions[0]!.sourceHomeId,
          clientScopes: ["operator.admin"],
        }),
      ).rejects.toThrow("Codex supervision is disabled");
    });
    expect(createSessionEntry).not.toHaveBeenCalled();
  },
);
