import { describe, expect, it } from "vitest";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import { resolveCliBootstrapPromptHash } from "./bootstrap-transport.js";

describe("personal CLI prompt refresh", () => {
  const baseHash = hashCliSessionText("stable instructions");
  const personal = (id: string, content = "preferences") => [
    { path: "/workspace/users/" + id + "/USER.md", content, personalUser: true as const },
  ];
  const hash = (
    contextFiles: Parameters<typeof resolveCliBootstrapPromptHash>[0]["contextFiles"],
  ) => resolveCliBootstrapPromptHash({ baseHash, bootstrapMode: "none", contextFiles });
  it("does not refresh personal context for a shared USER file under a users directory", () => {
    expect(hash([{ path: "/srv/users/arbitrary/USER.md", content: "Shared preferences" }])).toBe(
      baseHash,
    );
  });

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
