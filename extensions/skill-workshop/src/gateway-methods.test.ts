import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { canonicalizePath } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillWorkshopGatewayMethods } from "./gateway-methods.js";
import { WorkshopReviewNotFoundError } from "./review-undo.js";
import { setWorkshopRuntime } from "./runtime.js";
import * as skillsRootModule from "./skills-root.js";
import { useWorkshopPluginScope } from "./test-support.js";

const library = vi.hoisted(() => ({
  WorkshopWriteError: class WorkshopWriteError extends Error {},
  listWorkshopSkills: vi.fn(),
  listWorkshopArchive: vi.fn(),
  listWorkshopChanges: vi.fn(),
  viewWorkshopSkill: vi.fn(),
  archiveWorkshopSkill: vi.fn(),
  restoreWorkshopSkill: vi.fn(),
}));
const readUsage = vi.hoisted(() => vi.fn());
const undoWorkshopReview = vi.hoisted(() => vi.fn());

vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  ...library,
}));
vi.mock("./review-undo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-undo.js")>()),
  undoWorkshopReview,
}));

const { run, scoped } = useWorkshopPluginScope();
const { resolveWorkshopDraftsDir, resolveWorkshopSkillsDir } = scoped(skillsRootModule);

type Handler = (invocation: GatewayRequestHandlerOptions) => Promise<void>;
const handlers = new Map<string, Handler>();
registerSkillWorkshopGatewayMethods(
  createTestPluginApi({
    registerGatewayMethod: (method, handler) => {
      handlers.set(method, handler as Handler);
    },
  }),
);

/** Invokes a registered method inside the plugin's call scope and captures its response. */
async function callGatewayHandler(
  method: string,
  params: Record<string, unknown>,
  options: { client?: unknown } = {},
) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  await run(() =>
    handlers.get(method)!({
      req: { type: "req", id: "test", method, params },
      params,
      client: (options.client ?? null) as GatewayRequestHandlerOptions["client"],
      isWebchatConnect: () => false,
      context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
      respond: (nextOk, nextResponse, nextError) => {
        ok = nextOk;
        response = nextResponse;
        error = nextError;
      },
    } as GatewayRequestHandlerOptions),
  );
  return { ok, response, error };
}

const config: OpenClawConfig = {
  agents: { entries: { ops: {} } },
  plugins: { entries: { "skill-workshop": { config: { autonomous: { mode: "off" } } } } },
  meta: { migrations: { skillWorkshopPlugin: true } },
};
const call = (method: string, params: Record<string, unknown>) =>
  callGatewayHandler(method, params);
const expectInvalid = (result: Awaited<ReturnType<typeof call>>, message?: string) =>
  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", ...(message === undefined ? {} : { message }) },
  });

const change = { id: "change-1" };

describe("skills.workshop gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    run(() =>
      setWorkshopRuntime({
        config: { current: () => config },
        skills: { readUsage },
      } as unknown as Parameters<typeof setWorkshopRuntime>[0]),
    );
  });

  it("lists skills with usage keyed by the canonical SKILL.md path", async () => {
    const root = resolveWorkshopSkillsDir(config, "ops");
    const usedFile = canonicalizePath(path.join(root, "deploy-notes", "SKILL.md"));
    const summary = { description: "d", updatedAtMs: 1, sizeBytes: 10, files: ["SKILL.md"] };
    library.listWorkshopSkills.mockResolvedValue([
      { name: "deploy-notes", ...summary },
      { name: "unused", ...summary },
    ]);
    const archived = [{ name: "old", live: false, versions: [] }];
    library.listWorkshopArchive.mockResolvedValue(archived);
    readUsage.mockResolvedValue({
      tracked: true,
      usage: new Map([[usedFile, { useCount: 3, lastUsedAtMs: 9 }]]),
    });

    const result = await call("skills.workshop.list", {});

    expect(result.ok).toBe(true);
    expect(result.response).toEqual({
      agentId: "ops",
      mode: "off",
      root,
      skills: [
        { name: "deploy-notes", ...summary, useCount: 3, lastUsedAtMs: 9 },
        { name: "unused", ...summary },
      ],
      archived,
      drafts: [],
    });
  });

  it("pages changes and reads skill files for the resolved agent", async () => {
    library.listWorkshopChanges.mockResolvedValue([change]);
    const view = { name: "deploy-notes", filePath: "SKILL.md", content: "x", files: ["SKILL.md"] };
    library.viewWorkshopSkill.mockResolvedValue(view);

    const changes = await call("skills.workshop.changes", { limit: 5, beforeMs: 100 });
    const read = await call("skills.workshop.read", {
      name: "deploy-notes",
      versionId: "20260929T000000000Z-patch",
    });

    expect(changes.response).toEqual({ changes: [change] });
    expect(library.listWorkshopChanges).toHaveBeenCalledWith("ops", { limit: 5, beforeMs: 100 });
    expect(read.response).toEqual(view);
    expect(library.viewWorkshopSkill).toHaveBeenCalledWith(
      config,
      "ops",
      "deploy-notes",
      undefined,
      "20260929T000000000Z-patch",
    );
  });

  it.each([
    ["skills.workshop.archive", { name: "deploy-notes" }],
    ["skills.workshop.restore", { name: "deploy-notes" }],
    ["skills.workshop.undo", { runId: "skill-workshop-review:1" }],
  ])("refuses %s once the requester loses authority after admission", async (method, params) => {
    const client = { invalidated: false };
    // The library calls assertLive right before its final file effect.
    const revokeThenCommit = async (ctx: { assertLive: () => void }) => {
      client.invalidated = true;
      ctx.assertLive();
      return change;
    };
    library.archiveWorkshopSkill.mockImplementation(revokeThenCommit);
    library.restoreWorkshopSkill.mockImplementation(revokeThenCommit);
    undoWorkshopReview.mockImplementation(revokeThenCommit);

    await expect(callGatewayHandler(method, params, { client })).rejects.toThrow(
      "Gateway requester authority changed",
    );
  });

  it.each(["skills.workshop.applyDraft", "skills.workshop.discardDraft"])(
    "refuses %s for a requester whose authority is gone and keeps the draft",
    async (method) => {
      const draftDir = path.join(resolveWorkshopDraftsDir(config, "ops"), "deploy-notes-1a2b3c4d");
      const draftFile = path.join(draftDir, "SKILL.md");
      await fs.mkdir(draftDir, { recursive: true });
      await fs.writeFile(draftFile, "---\nname: deploy-notes\ndescription: d\n---\n\n1. Step.\n");
      try {
        await expect(
          callGatewayHandler(
            method,
            { name: "deploy-notes", draftId: "deploy-notes-1a2b3c4d" },
            { client: { invalidated: true } },
          ),
        ).rejects.toThrow("Gateway requester authority changed");
        expect(await fs.readFile(draftFile, "utf8")).toContain("1. Step.");
      } finally {
        await fs.rm(draftDir, { recursive: true, force: true });
      }
    },
  );

  it("returns library refusals and unknown agents as invalid requests", async () => {
    const missingSkill = 'Skill "ghost" does not exist.';
    const missingReview = "No skill changes recorded for review skill-workshop-review:9.";
    library.archiveWorkshopSkill.mockRejectedValue(new library.WorkshopWriteError(missingSkill));

    expectInvalid(await call("skills.workshop.archive", { name: "ghost" }), missingSkill);
    expectInvalid(await call("skills.workshop.restore", { agentId: "nope", name: "x" }));
    undoWorkshopReview.mockRejectedValue(new WorkshopReviewNotFoundError(missingReview));
    expectInvalid(
      await call("skills.workshop.undo", { runId: "skill-workshop-review:9" }),
      missingReview,
    );
  });
});
