import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal mock of the plugin API
function createMockApi(workspaceDir: string, config: Record<string, unknown> = {}) {
  const handlers: Record<string, Function> = {};
  return {
    api: {
      config,
      workspaceDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
      },
    },
    handlers,
  };
}

describe("keyword-context plugin", () => {
  let tmpDir: string;
  let docsDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-context-test-"));
    docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });

    // Create test reference docs
    fs.writeFileSync(
      path.join(docsDir, "project-alpha.md"),
      "# Project Alpha\n\nAlpha is a test project for keyword injection.",
    );
    fs.writeFileSync(
      path.join(docsDir, "project-beta.md"),
      "# Project Beta\n\nBeta handles the secondary workload.",
    );

    // Create keyword map
    fs.writeFileSync(
      path.join(tmpDir, "keyword-map.json"),
      JSON.stringify({
        entries: [
          {
            id: "alpha",
            keywords: ["alpha", "project alpha"],
            path: "docs/project-alpha.md",
            ttlTurns: 3,
            maxChars: 5000,
            priority: 8,
          },
          {
            id: "beta",
            keywords: ["beta"],
            path: "docs/project-beta.md",
            ttlTurns: 2,
            maxChars: 5000,
            priority: 5,
          },
        ],
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects context when keyword is mentioned", async () => {
    const { api, handlers } = createMockApi(tmpDir);
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_prompt_build({
      sessionKey: "test-1",
      messages: [{ role: "user", content: "Tell me about alpha" }],
    });

    expect(result).toHaveProperty("prependContext");
    expect(result.prependContext).toContain("Project Alpha");
    expect(result.prependContext).toContain("[alpha]");
  });

  it("returns empty when no keywords match", async () => {
    const { api, handlers } = createMockApi(tmpDir);
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_prompt_build({
      sessionKey: "test-2",
      messages: [{ role: "user", content: "Hello, how are you?" }],
    });

    expect(result).toEqual({});
  });

  it("unloads after TTL expires", async () => {
    const { api, handlers } = createMockApi(tmpDir);
    const { default: register } = await import("./index.js");
    register(api as any);

    // Turn 1: mention beta (TTL = 2)
    handlers.before_prompt_build({
      sessionKey: "test-3",
      messages: [{ role: "user", content: "What about beta?" }],
    });

    // Turn 2: no mention (TTL → 1)
    const r2 = handlers.before_prompt_build({
      sessionKey: "test-3",
      messages: [{ role: "user", content: "Continue." }],
    });
    expect(r2.prependContext).toContain("beta");

    // Turn 3: no mention (TTL → 0, should unload)
    const r3 = handlers.before_prompt_build({
      sessionKey: "test-3",
      messages: [{ role: "user", content: "Something else entirely." }],
    });
    expect(r3).toEqual({});
  });

  it("respects maxConcurrentDocs", async () => {
    // Create a map with 3 entries but maxConcurrentDocs = 1
    const narrowDir = path.join(tmpDir, "narrow");
    fs.mkdirSync(path.join(narrowDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(narrowDir, "docs", "a.md"), "Doc A");
    fs.writeFileSync(path.join(narrowDir, "docs", "b.md"), "Doc B");
    fs.writeFileSync(
      path.join(narrowDir, "keyword-map.json"),
      JSON.stringify({
        entries: [
          { id: "a", keywords: ["aaa"], path: "docs/a.md", ttlTurns: 5, maxChars: 1000, priority: 10 },
          { id: "b", keywords: ["bbb"], path: "docs/b.md", ttlTurns: 5, maxChars: 1000, priority: 1 },
        ],
      }),
    );

    const { api, handlers } = createMockApi(narrowDir, { maxConcurrentDocs: 1 });
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_prompt_build({
      sessionKey: "test-4",
      messages: [{ role: "user", content: "both aaa and bbb mentioned" }],
    });

    // Only 1 doc should be injected (highest priority = "a")
    expect(result.prependContext).toContain("Doc A");
    expect(result.prependContext).not.toContain("Doc B");
  });

  it("handles missing keyword map gracefully", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const { api, handlers } = createMockApi(emptyDir);
    const { default: register } = await import("./index.js");
    register(api as any);

    const result = handlers.before_prompt_build({
      sessionKey: "test-5",
      messages: [{ role: "user", content: "alpha beta gamma" }],
    });

    expect(result).toEqual({});
  });
});
