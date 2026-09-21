import { describe, expect, it } from "vitest";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import { resolveCliBootstrapPromptHash } from "./bootstrap-transport.js";

describe("personal CLI prompt refresh", () => {
  const baseHash = hashCliSessionText("stable instructions");
  const personal = (id: string, content = "preferences") => [
    { path: "/workspace/users/" + id + "/USER.md", content },
  ];
  const hash = (contextFiles: ReturnType<typeof personal>) =>
    resolveCliBootstrapPromptHash({ baseHash, bootstrapMode: "none", contextFiles });
  it("refreshes a resumable CLI prompt on person changes, edits and removal", () => {
    const firstHash = hash(personal("alice"));
    for (const files of [personal("bob"), personal("alice", "updated preferences"), []]) {
      expect(
        resolveCliSessionReuse({
          authEpochVersion: 1,
          binding: { sessionId: "native-session", extraSystemPromptHash: firstHash },
          extraSystemPromptHash: hash(files),
        }),
      ).toMatchObject({ mode: "reuse-with-drift", drift: { reasons: ["system-prompt"] } });
    }
    expect(
      resolveCliSessionReuse({
        authEpochVersion: 1,
        binding: { sessionId: "native-session", extraSystemPromptHash: firstHash },
        extraSystemPromptHash: hash(personal("alice")),
      }),
    ).toMatchObject({ mode: "reuse" });
    expect(hash([])).toBe(baseHash);
  });
});
