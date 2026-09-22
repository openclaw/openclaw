// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

describe("prepared model runtime owner selection", () => {
  it.each(["lost claim", "invalidation", "close"] as const)(
    "does not accept a joined refresh after %s",
    async (boundary) => {
      mocks.configuredAgentIds = ["default"];
      const started = createDeferred();
      const release = createDeferred();
      mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
        started.resolve();
        await release.promise;
        return { agentDir: String(agentDir), wrote: false };
      });
      const first = refreshPreparedModelRuntimeSnapshots({}, { joinSupersedingPublication: true });
      const rejected = expect(first).rejects.toThrow(/superseded|closed/);
      let successor: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      try {
        await started.promise;
        if (boundary === "invalidation") {
          markPreparedModelRuntimeSnapshotsStale("publication owner retired");
        } else {
          let claimCurrent = true;
          successor = refreshPreparedModelRuntimeSnapshots(
            {},
            {
              isPublicationCurrent: () => claimCurrent,
            },
          );
          if (boundary === "lost claim") {
            claimCurrent = false;
          } else {
            closing = closePreparedModelRuntimeSnapshots();
          }
        }
        release.resolve();
        await rejected;
      } finally {
        release.resolve();
        await Promise.allSettled([first, successor, closing]);
      }
    },
  );

  it("joins the latest of multiple replacements without rebuilding skipped config", async () => {
    mocks.configuredAgentIds = ["default"];
    const started = createDeferred();
    const release = createDeferred();
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
      started.resolve();
      await release.promise;
      return { agentDir: String(agentDir), wrote: false };
    });
    const first = refreshPreparedModelRuntimeSnapshots({}, { joinSupersedingPublication: true });
    let skipped: Promise<void> | undefined;
    let latest: Promise<void> | undefined;
    try {
      await started.promise;
      skipped = refreshPreparedModelRuntimeSnapshots({ messages: { responsePrefix: "skipped" } });
      latest = refreshPreparedModelRuntimeSnapshots({ messages: { responsePrefix: "latest" } });
      release.resolve();
      await expect(first).resolves.toBeUndefined();
      await Promise.all([skipped, latest]);
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      expect(mocks.ensureOpenClawModelsJson.mock.calls.at(-1)?.[0]).toEqual({
        messages: { responsePrefix: "latest" },
      });
    } finally {
      release.resolve();
      await Promise.allSettled([first, skipped, latest]);
    }
  });

  it("joins a scoped successor only after both configured agents are current", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config);
    const read = (agentId: string) =>
      getPreparedModelRuntimeSnapshot({
        ...fixture.agentInput(agentId, config),
        workspaceDir: `/tmp/workspace-${agentId}`,
      });
    for (const agentId of mocks.configuredAgentIds) {
      expect(read(agentId)?.isCurrent()).toBe(true);
    }
    const started = createDeferred();
    const release = createDeferred();
    const successorStarted = createDeferred();
    const releaseSuccessor = createDeferred();
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async (_config, agentDir) => {
        started.resolve();
        await release.promise;
        return { agentDir: String(agentDir), wrote: false };
      })
      .mockImplementationOnce(async (_config, agentDir) => {
        successorStarted.resolve();
        await releaseSuccessor.promise;
        return { agentDir: String(agentDir), wrote: false };
      });
    const first = refreshPreparedModelRuntimeSnapshots(config, {
      agentIds: new Set(["agent-a"]),
      joinSupersedingPublication: true,
    });
    let settled = false;
    void first.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let successor: Promise<void> | undefined;
    try {
      await started.promise;
      successor = refreshPreparedModelRuntimeSnapshots(config, {
        agentIds: new Set(["agent-b"]),
      });
      release.resolve();
      await successorStarted.promise;
      expect(settled).toBe(false);
      expect(read("agent-a")).toBeUndefined();
      releaseSuccessor.resolve();
      await first;
      for (const agentId of mocks.configuredAgentIds) {
        expect(read(agentId)?.isCurrent()).toBe(true);
      }
      await successor;
    } finally {
      release.resolve();
      releaseSuccessor.resolve();
      await Promise.allSettled([first, successor]);
    }
  });

  it("stops a superseded same-directory batch before another catalog write", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b"];
    for (const agentId of mocks.configuredAgentIds) {
      mocks.configuredAgentDirs.set(agentId, fixture.state.agentDir("shared-catalog-agent-dir"));
      mocks.configuredWorkspaces.set(agentId, `/tmp/catalog-workspace-${agentId}`);
    }
    const staleConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const releaseStaleWriteGate = createDeferred();
    const staleWriteStarted = createDeferred();
    mocks.ensureOpenClawModelsJson.mockImplementation(async (config) => {
      if (isDeepStrictEqual(config, staleConfig)) {
        staleWriteStarted.resolve();
        await releaseStaleWriteGate.promise;
      }
      return { agentDir: fixture.state.agentDir("shared-catalog-agent-dir"), wrote: false };
    });

    let stale: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let latest: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      stale = refreshPreparedModelRuntimeSnapshots(staleConfig);
      await staleWriteStarted.promise;
      latest = refreshPreparedModelRuntimeSnapshots(latestConfig);
      releaseStaleWriteGate.resolve();

      await expect(stale).rejects.toThrow("superseded");
      await latest;
      expect(
        mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) =>
          isDeepStrictEqual(config, staleConfig),
        ),
      ).toHaveLength(1);
      expect(
        mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) =>
          isDeepStrictEqual(config, latestConfig),
        ),
      ).toHaveLength(2);
    } finally {
      releaseStaleWriteGate.resolve();
      await Promise.allSettled([stale, latest]);
    }
  });
});
