import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { skillLibraryRevisionDir } from "../../skills/library/bundle.js";
import * as selectionRead from "../../skills/library/selection-read.js";
import * as librarySelection from "../../skills/library/selection.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const resourceContent = "Selected library reference remains readable.";
const config = { plugins: { enabled: false }, tools: { fs: { workspaceOnly: true } } };
const toolOptions = {
  config,
  runtimeToolAllowlist: ["read"],
  toolConstructionPlan: {
    includeBaseCodingTools: true,
    includeShellTools: false,
    includeChannelTools: false,
    includeOpenClawTools: false,
    includePluginTools: false,
  },
};
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let fixture: Awaited<ReturnType<typeof createFixture>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  fixture = await createFixture();
});
afterEach(async () => {
  try {
    fixture?.host.closeHost();
    fixture?.host.closeAdmission();
    await state?.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function createFixture() {
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
  const { skillId, revision, name, ownerProfileId } = saved.entry;
  const pin = { skillId, revision, name, ownerProfileId };
  const snapshot: SkillSnapshot = {
    prompt: "",
    skills: [{ name: pin.name }],
    resolvedSkills: [],
    librarySelections: [pin],
  };
  await closeOpenClawStateDatabaseAsync();
  const controller = new AbortController();
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: path.basename(state.root),
    agentId: "main",
    workspaceDir: state.workspaceDir,
    cwd: state.workspaceDir,
    config,
    abortSignal: controller.signal,
    skillsSnapshot: snapshot,
  });
  return {
    host,
    controller,
    snapshot,
    resourcePath: path.join(
      skillLibraryRevisionDir(pin.skillId, pin.revision),
      "references/example.txt",
    ),
    build: () =>
      host.hostCapabilities.createToolSurfaceAsync!({
        ...toolOptions,
        workspaceDir: state.workspaceDir,
        cwd: state.workspaceDir,
      }),
  };
}
async function expectResource(tools: AnyAgentTool[], id: string) {
  const read = tools.find((tool) => tool.name === "read");
  expect(read).toBeDefined();
  const result = await read!.execute(id, { path: fixture.resourcePath });
  expect(result.content).toEqual([
    expect.objectContaining({ type: "text", text: expect.stringContaining(resourceContent) }),
  ]);
}

it("keeps pinned resources available to the deprecated synchronous host", async () => {
  await expectResource(
    fixture.host.hostCapabilities.createToolSurface!(toolOptions),
    "legacy-library",
  );
});

it("retains prepared resources after selections evict their shared cache entry", async () => {
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
    await expectResource(await fixture.build(), "evicted-library");
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it.each(["host close", "abort", "snapshot edit"] as const)(
  "retains the admitted pin during %s while its metadata read settles",
  async (change) => {
    const { host, build, controller, snapshot } = fixture;
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
        await expectResource(await pending, "captured-library");
      } else {
        await expect(pending).rejects.toThrow();
      }
    } finally {
      resume.resolve();
      await settled;
    }
  },
);
