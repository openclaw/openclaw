import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveBookWriterConfig } from "./config.js";
import { registerBookWriterGatewayMethods } from "./gateway.js";
import { listFinishedBookPlanProjects, readBookPlan } from "./planning.js";
import type { BookWriterAiHelpSuggestion, BookWriterDashboardSnapshot } from "./types.js";

type BookWriterManifest = {
  activation?: {
    onStartup?: boolean;
  };
};

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

async function tempOutputDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-gateway-test-"));
}

function bookTextFetch(text?: string): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (init?.method === "GET" && url.endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "Qwen/Qwen3-30B-A3B-Instruct-2507" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (init?.method === "GET" && url.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: [{ name: "qwen2.5:32b" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (init?.method === "GET" && url.endsWith("/api/ps")) {
      return new Response(
        JSON.stringify({
          models: [{ name: "qwen2.5:32b" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const content =
      text ??
      "On a rain-dark street, Mara tightened her grip on the invoice, signature, ledger clue, and evidence file while the clean mystery moved toward its final reveal. The records room shuddered in the storm, the council clock struck noon, and every careful choice she had avoided suddenly stood between the town and the truth waiting in the harbor books.";
    if (url.endsWith("/api/chat")) {
      return new Response(JSON.stringify({ message: { content }, eval_count: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function createApi() {
  const registerGatewayMethod = vi.fn();
  const api = { registerGatewayMethod } as unknown as OpenClawPluginApi;
  return { api, registerGatewayMethod };
}

function findHandler(
  registerGatewayMethod: ReturnType<typeof vi.fn>,
  method: string,
): GatewayHandler {
  const call = registerGatewayMethod.mock.calls.find((item) => item[0] === method);
  if (!call) {
    throw new Error(`missing handler for ${method}`);
  }
  return call[1] as GatewayHandler;
}

async function invoke(handler: GatewayHandler, params: Record<string, unknown>) {
  const box: {
    response?:
      | { ok: true; payload: unknown }
      | { ok: false; error: { code: string; message: string } };
  } = {};
  await handler({
    params,
    req: { type: "req", id: "test", method: "test" },
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      box.response = ok
        ? { ok: true, payload }
        : {
            ok: false,
            error: {
              code: error?.code ?? "error",
              message: error?.message ?? "unknown",
            },
          };
    },
  });
  if (!box.response) {
    throw new Error("handler did not respond");
  }
  return box.response;
}

function expectPayload(response: Awaited<ReturnType<typeof invoke>>): unknown {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.payload;
}

function expectSnapshot(response: Awaited<ReturnType<typeof invoke>>): BookWriterDashboardSnapshot {
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  expect(response.ok).toBe(true);
  return response.payload as BookWriterDashboardSnapshot;
}

describe("book-writer gateway planning methods", () => {
  it("declares startup activation for dashboard gateway methods", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as BookWriterManifest;

    expect(manifest.activation?.onStartup).toBe(true);
  });

  it("registers dashboard planning methods with operator scopes", () => {
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir: "/tmp/openclaw-book-writer-test" });

    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "bookWriter.dashboard.snapshot",
      "bookWriter.plan.create",
      "bookWriter.plan.createDraft",
      "bookWriter.plan.save",
      "bookWriter.plan.suggestSetupField",
      "bookWriter.plan.suggestField",
      "bookWriter.plan.generateIdeaSetup",
      "bookWriter.plan.generateChapterSetup",
      "bookWriter.plan.fillPlanSection",
      "bookWriter.penNames.update",
      "bookWriter.cover.localStatus",
      "bookWriter.cover.generateLocalImage",
      "bookWriter.cover.editLocalImage",
      "bookWriter.cover.generateConcept",
      "bookWriter.cover.generate",
      "bookWriter.cover.upload",
      "bookWriter.cover.approve",
      "bookWriter.automation.disable",
      "bookWriter.plan.delete",
      "bookWriter.plan.deleteMany",
      "bookWriter.plan.archive",
      "bookWriter.plan.copy",
      "bookWriter.plan.unarchive",
      "bookWriter.plan.deleteArchived",
      "bookWriter.plan.restore",
      "bookWriter.plan.deleteDeleted",
      "bookWriter.plan.emptyDeleted",
      "bookWriter.plan.finish",
      "bookWriter.plan.markPublished",
      "bookWriter.published.updateMetrics",
      "bookWriter.published.recommendNext",
      "bookWriter.plan.unfinish",
      "bookWriter.plan.draft",
      "bookWriter.plan.draftParagraph",
      "bookWriter.plan.propagateStoryChange",
      "bookWriter.plan.rebalance",
      "bookWriter.plan.stitch",
      "bookWriter.plan.package",
      "bookWriter.plan.fix",
      "bookWriter.publish.prepare",
      "bookWriter.plan.quickRead",
      "bookWriter.plan.reorderChapter",
      "bookWriter.plan.reorderParagraph",
    ]);
    expect(registerGatewayMethod.mock.calls[0][2]).toEqual({ scope: "operator.read" });
    expect(registerGatewayMethod.mock.calls[1][2]).toEqual({ scope: "operator.write" });
    expect(
      registerGatewayMethod.mock.calls.find(
        (call) => call[0] === "bookWriter.publish.prepare",
      )?.[2],
    ).toEqual({ scope: "operator.approvals" });
    expect(
      registerGatewayMethod.mock.calls.find(
        (call) => call[0] === "bookWriter.plan.emptyDeleted",
      )?.[2],
    ).toEqual({ scope: "operator.write" });
  });

  it("reports local AI health in dashboard snapshots", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const fetchImpl = bookTextFetch();
    const config = resolveBookWriterConfig({
      outputDir,
      localProvider: "ollama",
      localModel: "qwen2.5:32b",
      localBaseUrl: "http://127.0.0.1:11434",
    });
    registerBookWriterGatewayMethods({ api, config, fetchImpl });

    const dashboard = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.dashboard.snapshot"), {}),
    );

    expect(dashboard.generationModel).toEqual({
      provider: "ollama",
      model: "qwen2.5:32b",
    });
    expect(dashboard.localAiHealth).toMatchObject({
      status: "ready",
      provider: "ollama",
      model: "qwen2.5:32b",
      baseUrl: "http://127.0.0.1:11434",
      reachable: true,
      modelAvailable: true,
      modelLoaded: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reports local cover AI setup state and falls back to editable SVG concepts", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const localStatus = expectPayload(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.cover.localStatus"), {}),
    );
    expect(localStatus).toMatchObject({
      status: "fallback",
      message: expect.stringContaining("Local image AI is not ready"),
    });

    const created = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "A local AI cover workflow book for first-time authors.",
      }),
    );
    const generated = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.cover.generateLocalImage"), {
        runId: created.plan?.runId,
        baseVersion: created.plan?.version,
      }),
    );

    expect(generated.localCoverAiStatus.status).toBe("fallback");
    expect(generated.plan?.cover.variants[0]).toMatchObject({
      id: "auto-concept",
      label: "Editable SVG concept",
      source: "svg-concept",
      approved: false,
    });
    expect(generated.plan?.cover.variants[0]?.previewDataUrl).toMatch(/^data:image\/svg\+xml/);
  });

  it("suggests setup field text without creating a project", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({
      api,
      config,
      fetchImpl: bookTextFetch(
        "A polished book description about a bridge mystery with a stronger hook.",
      ),
    });

    const suggestion = expectPayload(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.suggestSetupField"), {
        topic: "A bridge mystery.",
        targetWords: 12000,
        tonePreset: "professional",
        profanityLevel: "none",
        intent: "improve",
      }),
    ) as BookWriterAiHelpSuggestion;

    expect(suggestion.runId).toBe("new-book-draft");
    expect(suggestion.suggestion).toContain("bridge mystery");
    expect(await fs.readdir(outputDir)).toEqual([]);
  });

  it("creates, saves, drafts, and stitches a plan through gateway snapshots", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const created = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original clean mystery about a bridge inspector who uncovers invoice fraud",
        targetWords: 1600,
        tonePreset: "humorous",
        profanityLevel: "mild",
      }),
    );
    expect(created.plan?.chapters.length).toBeGreaterThan(0);
    expect(created.plan?.styleGuide).toMatchObject({
      tonePreset: "humorous",
      profanityLevel: "mild",
    });
    expect(created.projects).toHaveLength(1);

    const plan = created.plan!;
    const saved = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.save"), {
        baseVersion: plan.version,
        plan: {
          ...plan,
          title: "Bridge Ledger",
          chapters: [
            {
              ...plan.chapters[0],
              title: "A Better First Chapter",
              paragraphs: plan.chapters[0].paragraphs,
            },
            ...plan.chapters.slice(1),
          ],
        },
      }),
    );
    expect(saved.plan?.title).toBe("Bridge Ledger");
    expect(saved.plan?.chapters[0].title).toBe("A Better First Chapter");

    const drafted = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.draft"), {
        runId: saved.plan?.runId,
        baseVersion: saved.plan?.version,
      }),
    );
    expect(drafted.planQuality?.status).toBe("pass");

    const stitched = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.stitch"), {
        runId: drafted.plan?.runId,
        baseVersion: drafted.plan?.version,
      }),
    );
    expect(stitched.manuscriptPreview).toContain("# Bridge Ledger");
    await expect(
      fs.stat(path.join(outputDir, stitched.plan!.runId, "manuscript.md")),
    ).resolves.toBeTruthy();
  });

  it("creates a complete editable draft from one book description", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const drafted = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.createDraft"), {
        topic:
          "An original clean mystery about a lighthouse keeper who discovers a forged harbor ledger",
        targetWords: 1600,
        tonePreset: "dramatic",
        profanityLevel: "none",
      }),
    );

    expect(drafted.plan?.status).toBe("stitched");
    expect(drafted.plan?.styleGuide).toMatchObject({
      tonePreset: "dramatic",
      profanityLevel: "none",
    });
    expect(drafted.planQuality?.counts.draftedParagraphs).toBe(
      drafted.planQuality?.counts.paragraphs,
    );
    expect(drafted.manuscriptPreview).toContain(`# ${drafted.plan!.title}`);
    expect(drafted.manuscriptPreview.toLowerCase()).not.toContain("ai will");
    await expect(
      fs.stat(path.join(outputDir, drafted.plan!.runId, "manuscript.md")),
    ).resolves.toBeTruthy();
  });

  it("deletes a plan through the gateway and returns to the home snapshot", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const first = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original clean mystery about a bridge inspector",
      }),
    );
    const second = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original practical guide to local publishing workflows",
      }),
    );

    const deleted = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.delete"), {
        runId: second.plan!.runId,
        selectedRunId: second.plan!.runId,
      }),
    );

    expect(deleted.projects.map((project) => project.runId)).toEqual([first.plan!.runId]);
    expect(deleted.selectedRunId).toBeNull();
    expect(deleted.plan).toBeNull();
    expect(deleted.deletedBooks).toEqual([
      expect.objectContaining({ runId: second.plan!.runId, title: second.plan!.title }),
    ]);
    await expect(fs.stat(path.join(outputDir, "_deleted-books"))).resolves.toBeTruthy();

    const restored = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.restore"), {
        deletedId: deleted.deletedBooks[0].deletedId,
      }),
    );
    expect(restored.plan?.runId).toBe(second.plan!.runId);
    expect(restored.projects.map((project) => project.runId)).toContain(second.plan!.runId);
    expect(restored.deletedBooks).toHaveLength(0);
  });

  it("moves multiple active books to Recently Deleted through one gateway call", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const first = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original clean mystery about duplicate library cleanup",
      }),
    );
    const second = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original clean mystery about duplicate library cleanup",
      }),
    );

    const deleted = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.deleteMany"), {
        runIds: [first.plan!.runId, second.plan!.runId],
        selectedRunId: second.plan!.runId,
      }),
    );

    expect(deleted.projects).toHaveLength(0);
    expect(deleted.plan).toBeNull();
    expect(deleted.deletedBooks.map((book) => book.runId).toSorted()).toEqual(
      [first.plan!.runId, second.plan!.runId].toSorted(),
    );

    const invalid = await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.deleteMany"), {
      runIds: [],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.message).toContain("runIds is required");
    }
  });

  it("permanently deletes recently deleted books through gateway snapshots", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const first = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original clean mystery about a deleted bridge",
      }),
    );
    const second = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original practical guide to emptying deleted books",
      }),
    );
    const firstDeleted = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.delete"), {
        runId: first.plan!.runId,
      }),
    );
    const secondDeleted = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.delete"), {
        runId: second.plan!.runId,
      }),
    );
    expect(secondDeleted.deletedBooks).toHaveLength(2);

    const oneRemoved = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.deleteDeleted"), {
        deletedId: firstDeleted.deletedBooks[0].deletedId,
      }),
    );
    expect(oneRemoved.deletedBooks.map((book) => book.runId)).toEqual([second.plan!.runId]);

    const invalid = await invoke(
      findHandler(registerGatewayMethod, "bookWriter.plan.deleteDeleted"),
      {
        deletedId: "../bad",
      },
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.message).toContain("deletedId is invalid");
    }

    const emptied = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.emptyDeleted"), {}),
    );
    expect(emptied.deletedBooks).toHaveLength(0);
  });

  it("drafts one paragraph through the gateway without touching the rest", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const created = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original book about one-paragraph AI controls",
      }),
    );
    const target = created.plan!.chapters[0].paragraphs[0];
    const drafted = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.draftParagraph"), {
        runId: created.plan!.runId,
        baseVersion: created.plan!.version,
        paragraphId: target.id,
      }),
    );

    expect(drafted.plan!.chapters[0].paragraphs[0].text.length).toBeGreaterThan(100);
    expect(drafted.plan!.chapters[0].paragraphs[1].text).toBe("");
  });

  it("does not auto-draft missing Book Text during package checks", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const created = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original book about manual-only package checks",
      }),
    );
    const packaged = await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.package"), {
      runId: created.plan!.runId,
      baseVersion: created.plan!.version,
    });

    expect(packaged.ok).toBe(false);
    if (!packaged.ok) {
      expect(packaged.error.message).toContain("Write missing Book Text");
    }
    const after = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.dashboard.snapshot"), {
        runId: created.plan!.runId,
      }),
    );
    expect(after.plan!.chapters[0].paragraphs[0].text).toBe("");
  });

  it("moves completed books to the finished shelf and restores them through the gateway", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const created = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original clean mystery about a finished bridge ledger",
      }),
    );

    const finished = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.finish"), {
        runId: created.plan!.runId,
        selectedRunId: created.plan!.runId,
        proof: {
          destination: "amazon-kdp",
          publishedAt: "2026-05-22",
          operatorConfirmed: true,
        },
      }),
    );

    expect(finished.projects).toHaveLength(0);
    expect(finished.plan).toBeNull();
    expect(finished.finishedBooks).toEqual([
      expect.objectContaining({ runId: created.plan!.runId, title: created.plan!.title }),
    ]);
    await expect(fs.stat(path.join(outputDir, "_finished-books"))).resolves.toBeTruthy();

    const restored = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.unfinish"), {
        finishedId: finished.finishedBooks[0].finishedId,
      }),
    );
    expect(restored.plan?.runId).toBe(created.plan!.runId);
    expect(restored.projects.map((project) => project.runId)).toEqual([created.plan!.runId]);
    expect(restored.finishedBooks).toHaveLength(0);
  });

  it("blocks Trophy Room moves without explicit operator publish confirmation", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const created = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original clean mystery about a bridge ledger that is not published yet",
      }),
    );

    const result = await invoke(
      findHandler(registerGatewayMethod, "bookWriter.plan.markPublished"),
      {
        runId: created.plan!.runId,
        proof: {
          destination: "amazon-kdp",
          publishedAt: "2026-05-22",
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("manual publish confirmation is required");
    }
    expect(await readBookPlan(config, created.plan!.runId)).toBeTruthy();
    expect(await listFinishedBookPlanProjects(config)).toHaveLength(0);
  });

  it("rejects stale dashboard saves with a version conflict", async () => {
    const outputDir = await tempOutputDir();
    const { api, registerGatewayMethod } = createApi();
    const config = resolveBookWriterConfig({ outputDir });
    registerBookWriterGatewayMethods({ api, config, fetchImpl: bookTextFetch() });

    const created = expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.create"), {
        topic: "An original book about local AI publishing",
      }),
    );
    const plan = created.plan!;

    expectSnapshot(
      await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.save"), {
        baseVersion: plan.version,
        plan: { ...plan, title: "First Save" },
      }),
    );
    const stale = await invoke(findHandler(registerGatewayMethod, "bookWriter.plan.save"), {
      baseVersion: plan.version,
      plan: { ...plan, title: "Stale Save" },
    });

    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.message).toContain("version conflict");
    }
  });
});
