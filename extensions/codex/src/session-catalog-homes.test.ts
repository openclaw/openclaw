import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createCodexCatalogHomeResolver } from "./session-catalog-homes.js";
import { MAX_HOST_COUNT } from "./session-catalog-parsing.js";

describe("Codex catalog home discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
