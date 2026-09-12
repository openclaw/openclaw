import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

describe("agent model discovery imports", () => {
  it("keeps model discovery independent of session execution", () => {
    expect(
      findSourceImportBackedges("src/agents/agent-model-discovery.ts", [
        "src/agents/sessions/agent-session.ts",
      ]),
    ).toEqual([]);
  });
});
