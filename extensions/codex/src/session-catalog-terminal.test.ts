import { describe, expect, it } from "vitest";
import {
  nodeHostMocks,
  tempDirs,
  registerCodexSessionCatalog,
  config,
  createControl,
  createRuntime,
  createGatewayApi,
  fs,
  os,
  path,
  resolveCodexAppServerLocalHomeDir,
  createCodexTestBindingStore,
  CODEX_LOCAL_SESSION_HOST_ID,
  createCodexSessionCatalogControlFactory,
  type CodexCatalogHome,
} from "./session-catalog.test-helpers.js";

describe("Codex catalog terminals", () => {
  it.each(["stdio", "unix", "websocket"] as const)(
    "keeps terminal capabilities and execution on the selected %s source",
    async (transport) => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-terminal-source-"));
      tempDirs.push(binDir);
      const executable = path.join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      await fs.writeFile(
        executable,
        process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n",
      );
      if (process.platform !== "win32") {
        await fs.chmod(executable, 0o755);
      }
      process.env.PATH = "";
      nodeHostMocks.userShellPaths.set("codex", binDir);
      const factory = createCodexSessionCatalogControlFactory({
        getPluginConfig: () => undefined,
        getRuntimeConfig: () => config,
      });
      const [primary] = await factory.homesForAgent("main");
      if (!primary) {
        throw new Error("expected a primary Codex home");
      }
      const source: CodexCatalogHome = {
        ...primary,
        sourceHomeId: transport === "stdio" ? "synthetic-home-secondary" : "synthetic-home-remote",
        hostId:
          transport === "stdio"
            ? CODEX_LOCAL_SESSION_HOST_ID
            : `${CODEX_LOCAL_SESSION_HOST_ID}:synthetic-home-remote`,
        label: transport === "stdio" ? "Local Codex · Secondary" : "Remote Codex",
        appServer: {
          ...primary.appServer,
          start: { ...primary.appServer.start, transport },
        },
      };
      const threadId =
        transport === "stdio"
          ? "123e4567-e89b-12d3-a456-426614174000"
          : "123e4567-e89b-12d3-a456-426614174001";
      const control = createControl({
        listPage: async () => ({
          sessions: [
            {
              threadId,
              name: transport === "stdio" ? "Secondary source session" : "Remote source session",
              cwd: "/synthetic/project",
              status: "idle",
              source: "cli",
              archived: false,
            },
          ],
        }),
      });
      const { runtime } = createRuntime();
      const { api, getProvider } = createGatewayApi(runtime);
      registerCodexSessionCatalog({
        api,
        bindingStore: createCodexTestBindingStore(),
        control: {
          ...factory,
          homesForAgent: async () => [source],
          forRequest: () => control,
        },
        getRuntimeConfig: () => config,
      });
      const provider = getProvider()!;
      const hosts = await provider.list({});
      expect(hosts).toMatchObject([
        {
          hostId: source.hostId,
          canStartTerminal: transport === "stdio",
          sessions: [{ threadId, canOpenTerminal: transport === "stdio" }],
        },
      ]);
      const request = {
        hostId: source.hostId,
        threadId,
        sourceHomeId: source.sourceHomeId,
      };
      if (transport === "stdio") {
        await expect(provider.openTerminal!(request)).resolves.toMatchObject({
          kind: "local",
          argv: [executable, "resume", threadId],
          env: {
            CODEX_HOME: resolveCodexAppServerLocalHomeDir(source.appServer.start, source.agentDir),
          },
        });
      } else {
        await expect(provider.openTerminal!(request)).rejects.toThrow(
          "Native terminal requires a local Codex source",
        );
      }
      await expect(
        provider.openTerminal!({ ...request, sourceHomeId: "removed-home" }),
      ).rejects.toThrow("Codex session source home is unavailable");
    },
  );
});
