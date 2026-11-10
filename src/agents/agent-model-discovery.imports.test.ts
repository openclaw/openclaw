import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

describe("agent model discovery imports", () => {
  it("keeps catalog publication independent of session execution and config I/O", () => {
    expect(
      findSourceImportBackedges(
        [
          "src/agents/prepared-model-catalog.worker.ts",
          "src/agents/prepared-model-runtime.full-catalog.ts",
          "src/agents/prepared-model-runtime.scoped-catalog.ts",
          "src/agents/models-config.prepared.ts",
        ],
        [
          "src/agents/ai-transport-runtime-host.ts",
          "packages/ai/src/transports.ts",
          "src/agents/sessions/auth-storage.ts",
          "src/agents/sessions/model-registry.ts",
          "src/agents/sessions/resolve-config-value.ts",
          "src/config/config.ts",
          "src/config/io.ts",
          "src/config/io.runtime.ts",
        ],
      ),
    ).toEqual([]);
    // Session discovery remains a real mutable-store consumer; the graph must see that edge.
    expect(
      findSourceImportBackedges("src/agents/agent-model-discovery.ts", [
        "src/agents/sessions/model-registry.ts",
      ]),
    ).not.toEqual([]);
  });

  it("keeps model discovery independent of session execution", () => {
    expect(
      findSourceImportBackedges("src/agents/agent-model-discovery.ts", [
        "src/agents/sessions/agent-session.ts",
      ]),
    ).toEqual([]);
  });
});
