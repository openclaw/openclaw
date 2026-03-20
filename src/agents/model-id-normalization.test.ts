import { describe, expect, it } from "vitest";
import { normalizeXaiModelId } from "./model-id-normalization.js";

describe("normalizeXaiModelId", () => {
  it("maps deprecated grok 4.20 beta ids to GA ids", () => {
    expect(normalizeXaiModelId("grok-4.20-experimental-beta-0304-reasoning")).toBe(
      "grok-4.20-reasoning",
    );
    expect(normalizeXaiModelId("grok-4.20-experimental-beta-0304-non-reasoning")).toBe(
      "grok-4.20-non-reasoning",
    );
  });

  it("leaves current xai model ids unchanged", () => {
    expect(normalizeXaiModelId("grok-4.20-reasoning")).toBe("grok-4.20-reasoning");
    expect(normalizeXaiModelId("grok-4")).toBe("grok-4");
  });
});
