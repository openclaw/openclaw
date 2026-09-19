import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./app-server/client.js";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { clearSharedCodexAppServerClientAndWait } from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import { createCodexCatalogHomeResolver } from "./session-catalog-homes.js";
import { MAX_HOST_COUNT } from "./session-catalog-parsing.js";

describe("Codex catalog home discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    { homeScope: "agent", initiallyMissing: false, aliasKind: "agent-directory" },
    { homeScope: "user", initiallyMissing: false, aliasKind: "user-home" },
    { homeScope: "agent", initiallyMissing: true, aliasKind: "agent-directory" },
    { homeScope: "agent", initiallyMissing: false, aliasKind: "home-leaf" },
  ] as const)(
    "keeps the captured $homeScope home across $aliasKind retargeting and client restart (initiallyMissing=$initiallyMissing)",
    async ({ homeScope, initiallyMissing, aliasKind }) => {
      const root = tempDirs.make("codex-catalog-home-alias-");
      const targetsRoot = aliasKind === "home-leaf" ? path.join(root, "agent") : root;
      const homeA = path.join(targetsRoot, "a", "codex-home");
      const homeB = path.join(targetsRoot, "b", "codex-home");
      for (const [home, receipt] of [
        [homeA, "home-a"],
        [homeB, "home-b"],
      ] as const) {
        await fs.mkdir(path.dirname(home), { recursive: true });
        if (!initiallyMissing || home !== homeA) {
          await fs.mkdir(home);
        }
        await fs.writeFile(path.join(path.dirname(home), "receipt"), receipt);
      }
      const canonicalA = path.join(await fs.realpath(path.dirname(homeA)), "codex-home");
      const canonicalB = await fs.realpath(homeB);
      const alias =
        aliasKind === "home-leaf"
          ? path.join(targetsRoot, "codex-home")
          : path.join(root, "selected");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      const aliasTarget = (home: string) =>
        aliasKind === "agent-directory" ? path.dirname(home) : home;
      await fs.symlink(aliasTarget(homeA), alias, linkType);
      let config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            alpha: { agentDir: aliasKind === "agent-directory" ? alias : path.join(root, "agent") },
          },
        },
      };
      const factory = createCodexSessionCatalogControl({
        config,
        getRuntimeConfig: () => config,
        getPluginConfig: () => ({
          appServer: { transport: "stdio", homeScope, command: process.execPath },
        }),
        resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
        env: { CODEX_HOME: homeScope === "user" ? alias : path.join(root, "native") },
      });
      const launchedHomes: string[] = [];
      const threadId = "123e4567-e89b-12d3-a456-426614174001";
      const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async (options) => {
        const launchHome = options?.env?.CODEX_HOME;
        if (!launchHome) {
          throw new Error("native catalog startup omitted CODEX_HOME");
        }
        const physicalHome = await fs.realpath(launchHome);
        const receipt = await fs.readFile(path.join(path.dirname(physicalHome), "receipt"), "utf8");
        launchedHomes.push(physicalHome);
        return createClientHarness({
          onWrite: (line, send) => {
            const request = JSON.parse(line) as { id?: number; method: string };
            if (request.method === "initialize") {
              send({
                id: request.id,
                result: {
                  userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}`,
                  codexHome: physicalHome,
                },
              });
            } else if (request.method === "thread/read") {
              send({
                id: request.id,
                result: { thread: { ...threadStartResult(threadId).thread, name: receipt } },
              });
            } else if (request.method !== "initialized") {
              throw new Error(`unexpected catalog request: ${request.method}`);
            }
          },
        }).client;
      });
      const read = (source: Awaited<ReturnType<typeof factory.forNode>>) =>
        source.control.withPinnedConnection(
          async (control) => (await control.readThread(threadId)).name,
        );
      try {
        const captured = await factory.forNode("alpha");
        if (initiallyMissing) {
          await expect(fs.stat(homeA)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expect(read(captured)).resolves.toBe("home-a");
        expect((await fs.stat(homeA)).isDirectory()).toBe(true);
        await expect(read(captured)).resolves.toBe("home-a");
        expect(launchedHomes).toEqual([canonicalA]);

        await fs.unlink(alias);
        await fs.symlink(aliasTarget(homeB), alias, linkType);
        const candidates = await factory.homesForAgent("alpha");
        expect(candidates[0]?.sourceHomeId).toBe(captured.sourceHomeId);
        expect(candidates[0]?.localSessionsRoot).toBe(path.join(canonicalA, "sessions"));
        expect(
          candidates.some((home) => home.localSessionsRoot === path.join(canonicalB, "sessions")),
        ).toBe(false);
        expect(candidates[0]?.appServer.start.homeScope).toBe(homeScope);
        if (homeScope === "agent") {
          expect(candidates[0]?.appServer.start.env?.CODEX_HOME).toBeUndefined();
        }
        await clearSharedCodexAppServerClientAndWait();
        const sameGeneration = await factory.forNode("alpha");
        expect(sameGeneration.sourceHomeId).toBe(captured.sourceHomeId);
        await expect(read(sameGeneration)).resolves.toBe("home-a");
        expect(launchedHomes).toEqual([canonicalA, canonicalA]);

        config = structuredClone(config);
        expect(() => captured.assertCurrent()).toThrow("configuration changed");
        await clearSharedCodexAppServerClientAndWait();
        const replacement = await factory.forNode("alpha");
        expect(replacement.sourceHomeId).not.toBe(captured.sourceHomeId);
        await expect(read(replacement)).resolves.toBe("home-b");
        expect(launchedHomes).toEqual([canonicalA, canonicalA, canonicalB]);
      } finally {
        await factory.stop();
        await clearSharedCodexAppServerClientAndWait();
        start.mockRestore();
      }
    },
  );

  it("leaves agent runtime preparation cold until that owner requests the catalog", async () => {
    const root = tempDirs.make("codex-catalog-lazy-");
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          alpha: { agentDir: path.join(root, "alpha") },
          beta: { agentDir: path.join(root, "beta") },
        },
      },
    };
    const resolveRuntimeOptions = vi.fn(
      (options: Parameters<typeof resolveCodexSupervisionAppServerRuntimeOptions>[0] = {}) => {
        if (options?.agentDir === path.join(root, "alpha")) {
          throw new Error("alpha runtime is unavailable");
        }
        return resolveCodexSupervisionAppServerRuntimeOptions(options);
      },
    );
    const resolver = createCodexCatalogHomeResolver({
      config,
      getRuntimeConfig: () => config,
      getPluginConfig: () => ({}),
      resolveRuntimeOptions,
      env: { CODEX_HOME: path.join(root, "native") },
    });

    expect(resolveRuntimeOptions).not.toHaveBeenCalled();
    const homes = await resolver.forAgent("beta");
    expect(homes[0]).toMatchObject({ label: "Local Codex", agentDir: path.join(root, "beta") });
    expect(resolveRuntimeOptions).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentDir: path.join(root, "beta"),
        config,
      }),
    );
  });

  it("serves HTTP and a replacement owner while obsolete discovery is pending", async () => {
    const root = tempDirs.make("codex-catalog-generation-");
    const alpha = { agentDir: path.join(root, "alpha") };
    const beta = { agentDir: path.join(root, "beta") };
    await Promise.all(
      [alpha, beta].map(({ agentDir }) =>
        fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true }),
      ),
    );
    let config: OpenClawConfig = { agents: { ownership: "explicit", entries: { alpha, beta } } };
    const resolver = createCodexCatalogHomeResolver({
      config,
      getRuntimeConfig: () => config,
      getPluginConfig: () => ({ appServer: { homeScope: "agent" } }),
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
      env: { CODEX_HOME: path.join(root, "native") },
    });
    const directoryStat = await fs.stat(root);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const stat = vi.spyOn(fs, "stat").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return directoryStat;
    });
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const pending = resolver.forAgent("beta");
    const rejected = expect(pending).rejects.toThrow("configuration changed");
    try {
      await entered.promise;
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP probe did not bind");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: { connection: "close" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      config = { agents: { ownership: "explicit", entries: { alpha } } };
      expect((await resolver.forAgent("alpha"))[0]?.agentDir).toBe(alpha.agentDir);
      expect(await resolver.forAgent("beta")).toEqual([]);
      release.resolve();
      await rejected;
    } finally {
      release.resolve();
      await Promise.allSettled([pending, rejected]);
      stat.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("stops shared fleet discovery at the existing host limit", async () => {
    const root = tempDirs.make("codex-catalog-limit-");
    const entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]> = {};
    for (let index = 0; index < MAX_HOST_COUNT; index++) {
      const id = `agent-${String(index).padStart(3, "0")}`;
      const agentDir = path.join(root, id);
      await fs.mkdir(path.join(agentDir, "codex-home"), { recursive: true });
      entries[id] = { agentDir };
    }
    const selectedDir = path.join(root, "zzselected");
    await fs.mkdir(path.join(selectedDir, "codex-home"), { recursive: true });
    entries.zzselected = { agentDir: selectedDir };
    const unusedHome = path.join(root, "zzzunused", "codex-home");
    entries.zzzunused = { agentDir: path.dirname(unusedHome) };
    const config: OpenClawConfig = { agents: { ownership: "explicit", entries } };
    const resolver = createCodexCatalogHomeResolver({
      config,
      getRuntimeConfig: () => config,
      getPluginConfig: () => ({}),
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
      env: { CODEX_HOME: path.join(root, "native") },
    });
    const stat = vi.spyOn(fs, "stat");
    try {
      const homes = await resolver.forAgent("zzselected");
      expect(homes).toHaveLength(MAX_HOST_COUNT);
      expect(homes[1]?.label).toBe("Local Codex · zzselected");
      expect(stat.mock.calls.some(([pathname]) => pathname === unusedHome)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });
});
