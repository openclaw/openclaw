// Imessage plugin tests cover CLI path tilde expansion.
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { expandIMessageUserPath, resolveLocalIMessageChatDbPath } from "./cli-path.js";

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
});
