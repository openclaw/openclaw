import { describe, expect, it } from "vitest";
import { parseViewerPayloadJson } from "./viewer-payload.js";

function buildValidPayload(): Record<string, unknown> {
  return {
    prerenderedHTML: "<div>ok</div>",
    langs: ["text"],
    oldFile: {
      name: "README.md",
      contents: "before",
    },
    newFile: {
      name: "README.md",
      contents: "after",
    },
    options: {
      theme: {
        light: "pierre-light",
        dark: "pierre-dark",
      },
      diffStyle: "unified",
      diffIndicators: "bars",
      disableLineNumbers: false,
      expandUnchanged: false,
      themeType: "dark",
      backgroundEnabled: true,
      overflow: "wrap",
      unsafeCSS: ":host{}",
    },
  };
}

describe("parseViewerPayloadJson", () => {
  it("accepts valid payload JSON", () => {
    const parsed = parseViewerPayloadJson(JSON.stringify(buildValidPayload()));
    expect(parsed.options.diffStyle).toBe("unified");
    expect(parsed.options.diffIndicators).toBe("bars");
  });

  it("rejects payloads with invalid shape", () => {
    const broken = buildValidPayload();
    broken.options = {
      ...(broken.options as Record<string, unknown>),
      diffIndicators: "invalid",
    };

    expect(() => parseViewerPayloadJson(JSON.stringify(broken))).toThrow(
      "Diff payload has invalid shape.",
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => parseViewerPayloadJson("{not-json")).toThrow("Diff payload is not valid JSON.");
  });
});
