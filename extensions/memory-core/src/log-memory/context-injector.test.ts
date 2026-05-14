import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextInjector } from "./context-injector.js";
import { LogIngestor } from "./ingestor.js";
import { KnowledgeCapture } from "./knowledge-capture.js";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeTempWorkspace } from "./test-helpers.js";

describe("ContextInjector", () => {
  const embed = makeFakeEmbedder(16);
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;
  let ingestor: LogIngestor;
  let capture: KnowledgeCapture;
  let injector: ContextInjector;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
    ingestor = new LogIngestor({ store, embed });
    capture = new KnowledgeCapture({ workspaceDir: workspace.dir, store, embed });
    injector = new ContextInjector(ingestor, { minScore: 0.0 });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it("returns empty string when no knowledge has been stored", async () => {
    const ctx = await injector.buildContext("write a linked list in C");
    expect(ctx).toBe("");
  });

  it("returns context block containing stored rule after capture", async () => {
    await capture.capture({
      message: "All pointer variables must start with lobster_.",
    });
    const ctx = await injector.buildContext("write a linked list in C");
    expect(ctx).toContain("lobster_");
    expect(ctx).toContain("[Relevant rules");
  });

  it("buildPinnedContext returns only pinned entries", async () => {
    await capture.capture({
      message: "TEACH: always sanitize inputs",
      pinned: true,
    });
    await capture.capture({
      message: "TEACH: temporary reminder, not pinned",
      pinned: false,
    });
    const ctx = await injector.buildPinnedContext();
    expect(ctx).toContain("sanitize inputs");
    expect(ctx).not.toContain("temporary reminder");
  });

  it("respects minScore filter", async () => {
    await capture.capture({ message: "TEACH: probe calibration daily" });
    const strictInjector = new ContextInjector(ingestor, { minScore: 0.999 });
    const ctx = await strictInjector.buildContext("something completely unrelated xyz qqq");
    expect(ctx).toBe("");
  });

  it("uses custom header when provided", async () => {
    await capture.capture({ message: "TEACH: always sanitize inputs" });
    const customInjector = new ContextInjector(ingestor, {
      minScore: 0.0,
      header: "[Custom header]",
    });
    const ctx = await customInjector.buildContext("sanitize user input");
    expect(ctx).toContain("[Custom header]");
  });
});
