// Imessage plugin tests cover CLI path tilde expansion.
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  expandIMessageUserPath,
  resolveIMessageChatDbLookupPath,
  resolveLocalIMessageChatDbPath,
} from "./cli-path.js";

describe("expandIMessageUserPath", () => {
  it("does not interpret $ patterns in home when expanding tildes", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/home/user$&d";
    try {
      expect(expandIMessageUserPath("~/Library/Messages/chat.db")).toBe(
        "/home/user$&d/Library/Messages/chat.db",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previous;
      }
    }
  });
});

describe("resolveLocalIMessageChatDbPath", () => {
  it.each(["binary", "wrapper"])(
    "attests a symlinked local %s and rejects remote hosts",
    async (kind) => {
      await withTempDir("openclaw-imsg-attestation-", async (root) => {
        const binary = path.join(root, "imsg");
        const wrapper = path.join(root, "wrapper");
        const alias = path.join(root, "alias");
        const dbPath = path.join(root, "chat.db");
        await writeFile(binary, Buffer.from("feedfacf", "hex"));
        await writeFile(wrapper, `#!/bin/sh\nexec "${binary}" "$@"\n`);
        await symlink(kind === "binary" ? binary : wrapper, alias, "file");

        expect(resolveLocalIMessageChatDbPath({ cliPath: alias, dbPath })).toBe(dbPath);
        expect(
          resolveLocalIMessageChatDbPath({ cliPath: alias, dbPath, remoteHost: "fixture.example" }),
        ).toBeUndefined();
      });
    },
  );

  it("preserves trailing whitespace in a configured dbPath instead of trimming it", async () => {
    await withTempDir("openclaw-imsg-whitespace-", async (root) => {
      const binary = path.join(root, "imsg");
      const alias = path.join(root, "alias");
      const dbPath = path.join(root, "chat.db ");
      await writeFile(binary, Buffer.from("feedfacf", "hex"));
      await symlink(binary, alias, "file");

      // The literal path (with its trailing space) must be preserved, not
      // silently rewritten into the trimmed path.
      expect(resolveLocalIMessageChatDbPath({ cliPath: alias, dbPath })).toBe(dbPath);
      expect(resolveLocalIMessageChatDbPath({ cliPath: alias, dbPath })).not.toBe(dbPath.trim());
    });
  });
});

describe("resolveIMessageChatDbLookupPath", () => {
  it.each(["/x/chat.db ", " /x/chat.db", " /x/chat.db "])(
    "preserves surrounding whitespace in %j instead of trimming it",
    (dbPath) => {
      // A config with surrounding whitespace is a distinct literal path.
      expect(resolveIMessageChatDbLookupPath({ cliPath: "imsg", dbPath })).toBe(dbPath);
    },
  );

  it.each([undefined, "", "   "])("treats a blank dbPath (%j) as unset", (dbPath) => {
    const previous = process.env.HOME;
    process.env.HOME = "/Users/gateway";
    try {
      // Blank is not a literal path, so the lookup falls back to the default chat.db.
      expect(resolveIMessageChatDbLookupPath({ cliPath: "imsg", dbPath })).toBe(
        "/Users/gateway/Library/Messages/chat.db",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previous;
      }
    }
  });
});
