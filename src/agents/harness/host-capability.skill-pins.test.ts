import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { skillLibraryRevisionDir } from "../../skills/library/bundle.js";
import * as selectionRead from "../../skills/library/selection-read.js";
import * as librarySelection from "../../skills/library/selection.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import * as agentTools from "../agent-tools.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const dirs = useStateDatabaseTempDirs();
const resourceContent = "Selected library reference remains readable.";
const config: OpenClawConfig = {
  plugins: { enabled: false },
  tools: { fs: { workspaceOnly: true } },
};

type LibraryHost = {
  host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>;
  build: () => ReturnType<typeof agentTools.createOpenClawCodingToolsInternalAsync>;
  controller: AbortController;
  snapshot: SkillSnapshot;
  databasePath: string;
  resourcePath: string;
};

async function withLibraryHost(run: (fixture: LibraryHost) => Promise<void>) {
  const root = dirs.make("host-library-pins-");
  const workspaceDir = dirs.make("host-library-workspace-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const profile = ensureProfileForEmail("reader@example.test");
    const saved = await saveSkillLibrary(
      {
        profileId: profile.id,
        scopes: ["operator.read", "operator.write"],
        getConfig: () => config,
        assertCurrent() {},
      },
      {
        slug: "guide",
        content: "---\nname: guide\ndescription: Saved procedure\n---\n# Synthetic guide\n",
        files: [{ path: "references/example.txt", content: resourceContent }],
        expectedRevision: null,
      },
    );
    const pin = {
      skillId: saved.entry.skillId,
      revision: saved.entry.revision,
      name: saved.entry.name,
      ownerProfileId: saved.entry.ownerProfileId,
    };
    const snapshot: SkillSnapshot = {
      prompt: "",
      skills: [{ name: pin.name }],
      resolvedSkills: [],
      librarySelections: [pin],
    };
    await closeOpenClawStateDatabaseAsync();
    const controller = new AbortController();
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: path.basename(root),
      agentId: "main",
      workspaceDir,
      cwd: workspaceDir,
      config,
      abortSignal: controller.signal,
      skillsSnapshot: snapshot,
    });
    try {
      await run({
        host,
        controller,
        snapshot,
        databasePath: path.join(root, "state", "openclaw.sqlite"),
        resourcePath: path.join(
          skillLibraryRevisionDir(pin.skillId, pin.revision),
          "references/example.txt",
        ),
        build: () =>
          host.hostCapabilities.createToolSurfaceAsync!({
            workspaceDir,
            cwd: workspaceDir,
            config,
            runtimeToolAllowlist: ["read"],
            toolConstructionPlan: {
              includeBaseCodingTools: true,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: false,
              includePluginTools: false,
            },
          }),
      });
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });
}

it("reads cold and warm pinned resources through awaited host construction without host SQL", async () => {
  await withLibraryHost(async ({ build, resourcePath }) => {
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      for (let pass = 0; pass < 2; pass++) {
        const read = (await build()).find((tool) => tool.name === "read");
        expect(read).toBeDefined();
        const result = await read!.execute(`library-${pass}`, { path: resourcePath });
        expect(result.content).toEqual([
          expect.objectContaining({ type: "text", text: expect.stringContaining(resourceContent) }),
        ]);
      }
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("keeps pinned resources available to the deprecated synchronous host", async () => {
  await withLibraryHost(async ({ host, resourcePath }) => {
    const read = host.hostCapabilities.createToolSurface!({
      config,
      runtimeToolAllowlist: ["read"],
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    }).find((tool) => tool.name === "read");
    expect(read).toBeDefined();
    const result = await read!.execute("legacy-library", { path: resourcePath });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining(resourceContent) }),
    ]);
  });
});

it("retains prepared resources after other selections evict their shared cache entry", async () => {
  await withLibraryHost(async ({ build, resourcePath }) => {
    const prepare = librarySelection.prepareSkillLibrarySelection;
    using _ = vi
      .spyOn(librarySelection, "prepareSkillLibrarySelection")
      .mockImplementationOnce(async (pins, options, assertCurrent) => {
        const entries = await prepare(pins, options, assertCurrent);
        for (let index = 0; index < 33; index++) {
          await prepare(
            pins.map((pin) => ({ ...pin, name: `${pin.name}-${index}` })),
            options,
            assertCurrent,
          );
        }
        return entries;
      });
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      const read = (await build()).find((tool) => tool.name === "read");
      const result = await read!.execute("evicted-library", { path: resourcePath });
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining(resourceContent) }),
      ]);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it.each(["host close", "abort", "snapshot edit"] as const)(
  "retains the admitted pin during %s while its metadata read settles",
  async (change) => {
    await withLibraryHost(async ({ host, build, controller, snapshot, resourcePath }) => {
      const entered = createDeferred();
      const resume = createDeferred();
      const readDescriptions = selectionRead.readSkillLibrarySelectionDescriptions;
      using _ = vi
        .spyOn(selectionRead, "readSkillLibrarySelectionDescriptions")
        .mockImplementationOnce(async (...args) => {
          const result = await readDescriptions(...args);
          entered.resolve();
          await resume.promise;
          return result;
        });
      const pending = build();
      const settled = pending.catch(() => undefined);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Host construction did not prepare pinned metadata in the worker",
        );
        if (change === "host close") {
          host.closeHost();
        } else if (change === "abort") {
          controller.abort();
        } else {
          snapshot.librarySelections![0]!.revision = "0".repeat(64);
          snapshot.skills.length = 0;
        }
        resume.resolve();
        if (change === "snapshot edit") {
          const read = (await pending).find((tool) => tool.name === "read");
          const result = await read!.execute("captured-library", { path: resourcePath });
          expect(result.content).toEqual([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(resourceContent),
            }),
          ]);
        } else {
          await expect(pending).rejects.toThrow();
        }
      } finally {
        resume.resolve();
        await settled;
      }
    });
  },
);

it.each(["admission close", "physical replacement"] as const)(
  "refuses pinned tool publication after %s during later tool preparation",
  async (change) => {
    await withLibraryHost(async ({ build, databasePath }) => {
      const entered = createDeferred();
      const resume = createDeferred();
      const construct = agentTools.createOpenClawCodingToolsInternalAsync;
      using _ = vi
        .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
        .mockImplementationOnce(async (...args) => {
          const tools = await construct(...args);
          entered.resolve();
          await resume.promise;
          return tools;
        });
      const pending = build();
      const settled = pending.catch(() => undefined);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Tool construction did not start",
        );
        if (change === "admission close") {
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
        } else {
          const replacement = `${databasePath}.replacement`;
          fs.copyFileSync(databasePath, replacement);
          fs.renameSync(replacement, databasePath);
        }
        resume.resolve();
        await expect(pending).rejects.toThrow();
      } finally {
        resume.resolve();
        await settled;
      }
    });
  },
);
