import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let sharedTempRoot = "";
let sharedTempId = 0;

beforeAll(() => {
  sharedTempRoot = fsSync.mkdtempSync(
    path.join(os.tmpdir(), "memory-host-sdk-workspace-reconcile-tests-"),
  );
});

afterAll(() => {
  if (sharedTempRoot) {
    fsSync.rmSync(sharedTempRoot, { recursive: true, force: true });
  }
});

function setupTempDirLifecycle(prefix: string): () => string {
  let tmpDir = "";
  beforeEach(() => {
    tmpDir = path.join(sharedTempRoot, `${prefix}${sharedTempId++}`);
    fsSync.mkdirSync(tmpDir, { recursive: true });
  });
  return () => tmpDir;
}

async function loadWorkspaceReconcileModule() {
  return import("./workspace-reconcile.js");
}

describe("workspace reconcile package helpers", () => {
  const getTmpDir = setupTempDirLifecycle("workspace-reconcile-");

  it("collects only approved markdown roots and builds managed payloads", async () => {
    const tmpDir = getTmpDir();
    fsSync.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Root\n\nWorkspace overview\n", "utf8");
    fsSync.mkdirSync(path.join(tmpDir, "memory"), { recursive: true });
    fsSync.mkdirSync(path.join(tmpDir, "rules-vault"), { recursive: true });
    fsSync.mkdirSync(path.join(tmpDir, "projects", "nested"), { recursive: true });
    fsSync.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    fsSync.writeFileSync(
      path.join(tmpDir, "memory", "daily.md"),
      "# Daily\n\nMemory note\n",
      "utf8",
    );
    fsSync.writeFileSync(
      path.join(tmpDir, "rules-vault", "policy.md"),
      "# Policy\n\nRules note\n",
      "utf8",
    );
    fsSync.writeFileSync(
      path.join(tmpDir, "projects", "nested", "demo.md"),
      "# Demo\n\nProject note\n",
      "utf8",
    );
    fsSync.writeFileSync(path.join(tmpDir, "notes", "ignored.md"), "# Ignore\n\nNope\n", "utf8");
    fsSync.writeFileSync(path.join(tmpDir, "memory.md"), "# Legacy\n\nIgnore\n", "utf8");

    const { WORKSPACE_RECONCILER_ID, collectWorkspaceReconcileFiles, buildWorkspaceReconcilePlan } =
      await loadWorkspaceReconcileModule();
    const files = await collectWorkspaceReconcileFiles(tmpDir);

    expect(files.map((file) => ({ path: file.path, root: file.root }))).toEqual([
      { path: "MEMORY.md", root: "MEMORY.md" },
      { path: "memory/daily.md", root: "memory" },
      { path: "rules-vault/policy.md", root: "rules-vault" },
      { path: "projects/nested/demo.md", root: "projects" },
    ]);

    const plan = await buildWorkspaceReconcilePlan(tmpDir, "2026-05-17T00:00:00.000Z");
    expect(plan.points.map((point) => point.id)).toEqual([
      "workspace:MEMORY.md#0",
      "workspace:memory/daily.md#0",
      "workspace:rules-vault/policy.md#0",
      "workspace:projects/nested/demo.md#0",
    ]);
    expect(plan.points[0]?.payload).toMatchObject({
      managed_by: WORKSPACE_RECONCILER_ID,
      path: "MEMORY.md",
      root: "MEMORY.md",
      chunk_index: 0,
      payload_schema_version: 2,
      synced_at: "2026-05-17T00:00:00.000Z",
    });
    expect(plan.points[3]?.payload).toMatchObject({
      managed_by: WORKSPACE_RECONCILER_ID,
      path: "projects/nested/demo.md",
      root: "projects",
      chunk_index: 0,
      title: "Demo",
      text_preview: expect.stringContaining("# Demo"),
    });
  });

  it("keeps unrelated heading chunks stable when one section changes", async () => {
    const tmpDir = getTmpDir();
    fsSync.mkdirSync(path.join(tmpDir, "projects"), { recursive: true });
    const docPath = path.join(tmpDir, "projects", "demo.md");
    fsSync.writeFileSync(
      docPath,
      [
        "# Alpha",
        "",
        "Alpha text.",
        "",
        "# Beta",
        "",
        "Beta text.",
        "",
        "# Gamma",
        "",
        "Gamma text.",
        "",
      ].join("\n"),
      "utf8",
    );

    const { buildWorkspaceReconcilePlan } = await loadWorkspaceReconcileModule();
    const firstPlan = await buildWorkspaceReconcilePlan(tmpDir, "2026-05-17T00:00:00.000Z");

    fsSync.writeFileSync(
      docPath,
      [
        "# Alpha",
        "",
        "Alpha text.",
        "",
        "# Beta",
        "",
        "Beta text changed with extra detail.",
        "",
        "# Gamma",
        "",
        "Gamma text.",
        "",
      ].join("\n"),
      "utf8",
    );

    const secondPlan = await buildWorkspaceReconcilePlan(tmpDir, "2026-05-17T00:05:00.000Z");

    expect(firstPlan.points.map((point) => point.id)).toEqual([
      "workspace:projects/demo.md#0",
      "workspace:projects/demo.md#1",
      "workspace:projects/demo.md#2",
    ]);
    expect(secondPlan.points.map((point) => point.id)).toEqual(
      firstPlan.points.map((point) => point.id),
    );
    expect(secondPlan.points[0]?.payload.content_hash).toBe(
      firstPlan.points[0]?.payload.content_hash,
    );
    expect(secondPlan.points[1]?.payload.content_hash).not.toBe(
      firstPlan.points[1]?.payload.content_hash,
    );
    expect(secondPlan.points[2]?.payload.content_hash).toBe(
      firstPlan.points[2]?.payload.content_hash,
    );
  });

  it("deletes only managed workspace ids and never the rollout canary", async () => {
    const { WORKSPACE_RECONCILER_ID, computeWorkspaceReconcileDeleteCandidates } =
      await loadWorkspaceReconcileModule();

    const deleteIds = computeWorkspaceReconcileDeleteCandidates(
      [
        {
          id: "workspace:MEMORY.md#0",
          payload: { managed_by: WORKSPACE_RECONCILER_ID },
        },
        {
          id: "workspace:projects/demo.md#0",
          payload: { managed_by: WORKSPACE_RECONCILER_ID },
        },
        {
          id: "rollout-canary",
          payload: { managed_by: "seed-script" },
        },
        {
          id: "workspace:notes/ignored.md#0",
          payload: { managed_by: "different-manager" },
        },
      ],
      new Set(["workspace:MEMORY.md#0"]),
    );

    expect(deleteIds).toEqual(["workspace:projects/demo.md#0"]);
  });

  it("surfaces non-missing filesystem errors during root scanning", async () => {
    const tmpDir = getTmpDir();
    const blockedDir = path.join(tmpDir, "memory");
    fsSync.mkdirSync(blockedDir, { recursive: true });
    fsSync.chmodSync(blockedDir, 0o000);

    const { collectWorkspaceReconcileFiles } = await loadWorkspaceReconcileModule();

    try {
      await expect(collectWorkspaceReconcileFiles(tmpDir)).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      fsSync.chmodSync(blockedDir, 0o755);
    }
  });

  it("rejects non-positive chunk limits", async () => {
    const { chunkWorkspaceMarkdownByHeading } = await loadWorkspaceReconcileModule();

    expect(() => chunkWorkspaceMarkdownByHeading("# Title\n\nBody\n", 0)).toThrow(
      "maxChars must be greater than 0",
    );
    expect(() => chunkWorkspaceMarkdownByHeading("# Title\n\nBody\n", -5)).toThrow(
      "maxChars must be greater than 0",
    );
  });

  it("ignores heading markers inside fenced code blocks", async () => {
    const { chunkWorkspaceMarkdownByHeading } = await loadWorkspaceReconcileModule();

    const backtickChunks = chunkWorkspaceMarkdownByHeading(
      [
        "Intro text.",
        "",
        "```ts",
        "# not-a-heading",
        "const value = 1;",
        "```",
        "",
        "# Real heading",
        "",
        "Actual section text.",
      ].join("\n"),
      4000,
    );

    expect(backtickChunks).toEqual([
      {
        text: ["Intro text.", "", "```ts", "# not-a-heading", "const value = 1;", "```"].join("\n"),
      },
      {
        text: "# Real heading\n\nActual section text.",
        title: "Real heading",
      },
    ]);

    const tildeChunks = chunkWorkspaceMarkdownByHeading(
      [
        "Intro text.",
        "",
        "~~~md",
        "# not-a-heading",
        "literal markdown sample",
        "~~~",
        "",
        "# Real heading",
        "",
        "Actual section text.",
      ].join("\n"),
      4000,
    );

    expect(tildeChunks).toEqual([
      {
        text: [
          "Intro text.",
          "",
          "~~~md",
          "# not-a-heading",
          "literal markdown sample",
          "~~~",
        ].join("\n"),
      },
      {
        text: "# Real heading\n\nActual section text.",
        title: "Real heading",
      },
    ]);
  });

  it("stores the full chunk text under the `document` payload key so mcp-server-qdrant qdrant-find can read it", async () => {
    const tmpDir = getTmpDir();
    fsSync.mkdirSync(path.join(tmpDir, "memory"), { recursive: true });
    const longParagraph = "alpha ".repeat(200).trimEnd();
    fsSync.writeFileSync(
      path.join(tmpDir, "memory", "long.md"),
      `# Long\n\n${longParagraph}\n`,
      "utf8",
    );

    const { buildWorkspaceReconcilePlan } = await loadWorkspaceReconcileModule();
    const plan = await buildWorkspaceReconcilePlan(tmpDir, "2026-05-17T00:00:00.000Z");
    const point = plan.points[0];

    expect(point).toBeDefined();
    expect(point?.payload.document).toBe(point?.text);
    expect(point?.payload.document).toContain(longParagraph);
    expect(point?.payload.document.length).toBeGreaterThan(point?.payload.text_preview.length ?? 0);
  });
});
