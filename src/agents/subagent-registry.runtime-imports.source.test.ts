import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("subagent registry runtime import footprint", () => {
  it("keeps registry lazy runtime surfaces in separate artifacts", () => {
    const source = readSource("./subagent-registry.ts");

    expect(source).toContain(
      'CONTEXT_ENGINE_INIT_RUNTIME_SPEC = ["./context-engine-init.runtime", ".js"]',
    );
    expect(source).toContain('RUNTIME_PLUGINS_RUNTIME_SPEC = ["./runtime-plugins.runtime", ".js"]');
    expect(source).toContain('"./context-engine-registry.runtime"');
    expect(source).not.toContain("SUBAGENT_REGISTRY_RUNTIME_SPEC");
  });

  it("keeps legacy context-engine compaction delegate off the init import path", () => {
    const source = readSource("../context-engine/legacy.ts");

    expect(source).toContain('import("./delegate.js")');
    expect(source).toContain("loadDelegateModule");
    expect(source).not.toContain('import { delegateCompactionToRuntime } from "./delegate.js"');
  });
});
