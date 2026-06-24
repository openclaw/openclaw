// Feishu mention normalization tests cover prefix collisions between non-zero-padded keys.
import { describe, expect, it } from "vitest";
import { normalizeMentions } from "./bot-content.js";

describe("normalizeMentions", () => {
  it("does not let a shorter mention key match inside a longer prefix-sharing key", () => {
    // Feishu emits @_user_1, @_user_10, @_user_11, ... (no zero padding) once 10+ users are
    // mentioned, so @_user_1 is a textual prefix of @_user_10/@_user_11.
    const result = normalizeMentions("Standup: @_user_1 @_user_10 @_user_11 done", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
      { key: "@_user_10", name: "Judy", id: { open_id: "ou_judy" } },
      { key: "@_user_11", name: "Kevin", id: { open_id: "ou_kevin" } },
    ]);
    expect(result).toBe(
      'Standup: <at user_id="ou_alice">Alice</at> <at user_id="ou_judy">Judy</at> <at user_id="ou_kevin">Kevin</at> done',
    );
  });

  it("replaces a longer key even when it is immediately followed by text", () => {
    const result = normalizeMentions("hi @_user_1, see @_user_10pinned", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
      { key: "@_user_10", name: "Judy", id: { open_id: "ou_judy" } },
    ]);
    expect(result).toBe(
      'hi <at user_id="ou_alice">Alice</at>, see <at user_id="ou_judy">Judy</at>pinned',
    );
  });
});
