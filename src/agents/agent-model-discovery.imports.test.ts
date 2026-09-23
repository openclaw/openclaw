import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

describe("agent model discovery imports", () => {
  it("keeps prepared catalog metadata independent of streaming execution", () => {
    expect(
      findSourceImportBackedges("src/agents/prepared-model-catalog.worker.ts", [
        "src/agents/ai-transport-runtime-host.ts",
        "packages/ai/src/transports.ts",
      ]),
    ).toEqual([]);
  });

  it("keeps model discovery independent of session execution", () => {
    expect(
      findSourceImportBackedges("src/agents/agent-model-discovery.ts", [
        "src/agents/sessions/agent-session.ts",
      ]),
    ).toEqual([]);
  });
});
