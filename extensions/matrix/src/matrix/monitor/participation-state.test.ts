import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MatrixAuth } from "../client/types.js";
import { createMatrixParticipationStateStore } from "./participation-state.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-participation-state-"));
}

const auth: MatrixAuth = {
  accountId: "default",
  homeserver: "https://matrix.example.test",
  userId: "@bot:example.test",
  accessToken: "secret-token",
};

describe("createMatrixParticipationStateStore", () => {
  it("writes central room-keyed state without raw directive source text", async () => {
    const storagePath = path.join(createTempDir(), "participation-state.json");
    const store = createMatrixParticipationStateStore({
      auth,
      storagePath,
      now: () => "2026-04-28T00:00:00.000Z",
    });

    await store.applyDirective({
      roomId: "!room:example.test",
      senderId: "@user:example.test",
      directive: {
        mode: "subset_only",
        includeAgentIds: ["forge"],
        sourceText: "Forge only, secret client body must not persist.",
        persistence: "room",
      },
    });

    const raw = fs.readFileSync(storagePath, "utf8");
    expect(raw).not.toContain("secret client body");
    const parsed = JSON.parse(raw) as {
      rooms: Record<string, { directive: Record<string, unknown> }>;
    };
    expect(parsed.rooms["!room:example.test"]?.directive).toMatchObject({
      mode: "subset_only",
      includeAgentIds: ["forge"],
      persistence: "room",
    });
    expect(parsed.rooms["!room:example.test"]?.directive.sourceText).toBeUndefined();
  });

  it("reloads central state with redacted source text", async () => {
    const storagePath = path.join(createTempDir(), "participation-state.json");
    const first = createMatrixParticipationStateStore({
      auth,
      storagePath,
      now: () => "2026-04-28T00:00:00.000Z",
    });
    await first.applyDirective({
      roomId: "!room:example.test",
      directive: {
        mode: "silence",
        sourceText: "Do not store this raw source.",
        persistence: "room",
      },
    });

    const second = createMatrixParticipationStateStore({ auth, storagePath });
    await expect(second.getRoomPolicy({ roomId: "!room:example.test" })).resolves.toMatchObject({
      mode: "silence",
      sourceText: expect.stringContaining("redacted"),
      persistence: "room",
    });
  });

  it("merges a current-account legacy store into central state preferring newer updatedAt", async () => {
    const dir = createTempDir();
    const centralPath = path.join(dir, "matrix", "participation-state.json");
    const legacyPath = path.join(
      dir,
      "matrix",
      "accounts",
      "default",
      "legacy",
      "hash",
      "participation-state.json",
    );
    fs.mkdirSync(path.dirname(centralPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      centralPath,
      JSON.stringify({
        version: 1,
        rooms: {
          "!same:example.test": {
            directive: { mode: "silence", persistence: "room" },
            updatedAt: "2026-04-28T00:00:00.000Z",
          },
        },
      }),
    );
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        rooms: {
          "!same:example.test": {
            directive: {
              mode: "subset_only",
              includeAgentIds: ["forge"],
              sourceText: "legacy raw",
              persistence: "room",
            },
            updatedAt: "2026-04-28T00:01:00.000Z",
          },
          "!legacy-only:example.test": {
            directive: {
              mode: "exclude_subset",
              excludeAgentIds: ["argus"],
              sourceText: "legacy raw",
              persistence: "room",
            },
            updatedAt: "2026-04-28T00:02:00.000Z",
          },
        },
      }),
    );

    const store = createMatrixParticipationStateStore({
      auth,
      storagePath: centralPath,
      legacyStoragePath: legacyPath,
    });
    await expect(store.getRoomPolicy({ roomId: "!same:example.test" })).resolves.toMatchObject({
      mode: "subset_only",
      includeAgentIds: ["forge"],
    });
    await expect(
      store.getRoomPolicy({ roomId: "!legacy-only:example.test" }),
    ).resolves.toMatchObject({
      mode: "exclude_subset",
      excludeAgentIds: ["argus"],
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
    const rawCentral = fs.readFileSync(centralPath, "utf8");
    expect(rawCentral).not.toContain("legacy raw");
  });
});
