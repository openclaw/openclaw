import { describe, expect, it } from "vitest";
import {
  expandCursorAcpGrokModelCandidates,
  resolveCursorAcpGrokHarnessCandidates,
} from "./cursor-acp-model.js";

describe("cursor-acp-model", () => {
  it("expands CLI medium alias through Carlos preference chain", () => {
    expect(expandCursorAcpGrokModelCandidates("cursor-grok-4.5-medium")).toEqual([
      "grok-4.5[effort=medium,fast=false]",
      "grok-4.5[effort=high,fast=false]",
      "grok-4.5[effort=high,fast=true]",
    ]);
  });

  it("never returns bare grok-4.5", () => {
    expect(expandCursorAcpGrokModelCandidates("grok-4.5")).toEqual([
      "grok-4.5[effort=medium,fast=false]",
      "grok-4.5[effort=high,fast=false]",
      "grok-4.5[effort=high,fast=true]",
    ]);
  });

  it("keeps advertised ids as-is", () => {
    expect(expandCursorAcpGrokModelCandidates("grok-4.5[effort=high,fast=true]")).toEqual([
      "grok-4.5[effort=high,fast=true]",
    ]);
  });

  it("exposes harness defaults in preference order", () => {
    expect(resolveCursorAcpGrokHarnessCandidates()[0]).toBe("grok-4.5[effort=medium,fast=false]");
    expect(resolveCursorAcpGrokHarnessCandidates().at(-1)).toBe("grok-4.5[effort=high,fast=true]");
  });
});
