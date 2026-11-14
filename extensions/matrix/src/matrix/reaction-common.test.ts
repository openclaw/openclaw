import { describe, expect, it } from "vitest";
import {
  buildMatrixReactionContent,
  buildMatrixReactionRelationsPath,
  extractMatrixReactionAnnotation,
  summarizeMatrixReactionEvents,
} from "./reaction-common.js";

const annotation = (key: string, event_id?: string, rel_type = "m.annotation") => ({
  "m.relates_to": { key, event_id, rel_type },
});
const reaction = (sender: string, key: string) => ({
  sender,
  content: annotation(key),
});

describe("matrix reaction helpers", () => {
  it.each([
    [" ", "👍", "Matrix reaction requires a messageId"],
    ["$msg", " ", "Matrix reaction requires an emoji"],
  ])("rejects blank reaction inputs (%j, %j)", (messageId, emoji, message) => {
    expect(() => buildMatrixReactionContent(messageId, emoji)).toThrow(message);
  });

  it("builds trimmed reaction content and relation paths", () => {
    expect(buildMatrixReactionContent(" $msg ", " 👍 ")).toEqual({
      "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key: "👍" },
    });
    expect(buildMatrixReactionRelationsPath("!room:example.org", " $msg ")).toContain(
      "/rooms/!room%3Aexample.org/relations/%24msg/m.annotation/m.reaction",
    );
  });

  it("summarizes reactions by emoji and unique sender", () => {
    expect(
      summarizeMatrixReactionEvents([
        { sender: "@alice:example.org", content: { "m.relates_to": { key: "👍" } } },
        reaction("@alice:example.org", "👍"),
        reaction("@bob:example.org", "👍"),
        reaction("@alice:example.org", "👎"),
        { sender: "@ignored:example.org", content: {} },
      ]),
    ).toEqual([
      { key: "👍", count: 3, users: ["@alice:example.org", "@bob:example.org"] },
      { key: "👎", count: 1, users: ["@alice:example.org"] },
    ]);
  });

  it("extracts annotations and ignores non-annotation relations", () => {
    expect(extractMatrixReactionAnnotation(annotation(" 👍 ", " $msg "))).toEqual({
      eventId: "$msg",
      key: "👍",
    });
    expect(extractMatrixReactionAnnotation(annotation("👍", "$msg", "m.replace"))).toBeUndefined();
  });
});
