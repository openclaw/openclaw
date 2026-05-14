import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectImplicitRule, detectTeachingMoment, KnowledgeCapture } from "./knowledge-capture.js";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeTempWorkspace } from "./test-helpers.js";

describe("detectTeachingMoment", () => {
  it.each([
    "TEACH: 校準失敗代表治具髒污",
    "FACT: probe must be calibrated daily",
    "RULE: never bypass safety interlocks",
    "the root cause is a stuck relay",
    "Note: keep an eye on humidity",
    "FYI: night shift saw the same fault",
    "這個錯誤是因為治具偏移",
    "原因是電源不穩",
    "下次遇到 abc 直接重置",
  ])("flags teaching message: %s", (msg) => {
    expect(detectTeachingMoment(msg)).toBe(true);
  });

  it.each(["just a normal log line", "", "ERROR: 0xDEADBEEF unrecognized opcode"])(
    "ignores non-teaching message: %s",
    (msg) => {
      expect(detectTeachingMoment(msg)).toBe(false);
    },
  );
});

describe("detectImplicitRule", () => {
  it.each([
    // Chinese implicit rules.
    "從現在起，你在寫 C code 的時候，所有的指標變數名稱都必須以 lobster_ 開頭，這是我公司的強硬規範。",
    "所有的函式名稱命名規則必須使用 snake_case。",
    "這個專案的命名慣例是 camelCase。",
    "所有的檔案格式規範如下。",
    "公司規定所有的 API 回傳值都要加上版本號。",
    "這是強硬規範：不能直接修改 main branch。",
    "開頭一律要加 ctx_ 前綴。",
    // English implicit rules.
    "All pointer variables must start with lobster_.",
    "Every function must be prefixed with the module name.",
    "Variable naming convention is snake_case.",
    "Files should be suffixed with .generated.ts.",
    "Our convention is to always use async/await.",
    "Company policy requires all commits to be signed.",
    "Pointer variables must be named starting with ptr_.",
  ])("flags implicit rule: %s", (msg) => {
    expect(detectImplicitRule(msg)).toBe(true);
  });

  it.each(["just a normal log line", "", "ok", "The build failed today.", "Please review the PR."])(
    "ignores non-rule message: %s",
    (msg) => {
      expect(detectImplicitRule(msg)).toBe(false);
    },
  );
});

describe("KnowledgeCapture (file-backed)", () => {
  const embed = makeFakeEmbedder(8);
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it("appends a semantic block to KNOWLEDGE.md and reports the path", async () => {
    const capture = new KnowledgeCapture({
      workspaceDir: workspace.dir,
      store,
      embed,
      now: () => new Date("2026-05-07T12:00:00Z"),
    });
    const result = await capture.maybeCapture({
      message: "TEACH: probe stuck means jig contamination",
      tags: ["service:diagfw"],
      title: "Probe stuck",
    });
    expect(result).not.toBeNull();
    expect(result!.knowledgeFilePath).toBe(store.semanticPath());
    expect(result!.entry.layer).toBe("semantic");
    expect(result!.entry.payload.type).toBe("engineer_knowledge");
    expect(result!.entry.payload.decayScore).toBe(0.95);
    const md = await fs.readFile(store.semanticPath(), "utf8");
    expect(md).toContain("## [2026-05-07T12:00:00.000Z] Probe stuck");
    expect(md).toContain("TEACH: probe stuck means jig contamination");
    expect(md).toContain("Source: engineer_teach");
    expect(md).toContain("source:engineer_teach");
  });

  it("returns null on non-teaching messages", async () => {
    const capture = new KnowledgeCapture({ workspaceDir: workspace.dir, store, embed });
    const result = await capture.maybeCapture({ message: "ordinary chat" });
    expect(result).toBeNull();
    expect(await store.countByLayer("semantic")).toBe(0);
  });

  it("captures implicit rule without explicit prefix and sets pinned + conversation_rule type", async () => {
    const capture = new KnowledgeCapture({
      workspaceDir: workspace.dir,
      store,
      embed,
      now: () => new Date("2026-05-07T12:00:00Z"),
    });
    const msg = "從現在起，所有的指標變數名稱都必須以 lobster_ 開頭，這是我公司的強硬規範。";
    const result = await capture.maybeCapture({ message: msg });
    expect(result).not.toBeNull();
    expect(result!.entry.payload.type).toBe("conversation_rule");
    expect(result!.entry.payload.pinned).toBe(true);
    const md = await fs.readFile(store.semanticPath(), "utf8");
    expect(md).toContain("lobster_");
    expect(md).toContain("Pinned: true");
    expect(md).toContain("Type: conversation_rule");
  });

  it("explicit capture defaults to pinned=true", async () => {
    const capture = new KnowledgeCapture({ workspaceDir: workspace.dir, store, embed });
    const result = await capture.capture({ message: "TEACH: always sanitize inputs" });
    expect(result.entry.payload.pinned).toBe(true);
  });

  it("explicit capture respects pinned: false override", async () => {
    const capture = new KnowledgeCapture({ workspaceDir: workspace.dir, store, embed });
    const result = await capture.capture({
      message: "TEACH: transient note, can decay",
      pinned: false,
    });
    expect(result.entry.payload.pinned).toBeFalsy();
  });
});
