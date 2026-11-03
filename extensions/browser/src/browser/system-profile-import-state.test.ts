import { describe, expect, it } from "vitest";
import {
  configureSystemProfileImportStateStore,
  dismissSystemProfileImportPrompt,
  readSystemProfileImportState,
  recordSystemProfileImport,
  resolveSuggestedImportTarget,
  type SystemProfileImportState,
} from "./system-profile-import-state.js";

function createMemoryStore(): Parameters<typeof configureSystemProfileImportStateStore>[0] {
  const values = new Map<string, SystemProfileImportState>();
  return {
    register: async (key, value) => {
      values.set(key, value);
    },
    lookup: async (key) => values.get(key),
  };
}

describe("system profile import state", () => {
  it("persists dismiss and successful import outcomes", async () => {
    configureSystemProfileImportStateStore(createMemoryStore());

    await dismissSystemProfileImportPrompt(10);
    expect(await readSystemProfileImportState()).toEqual({
      version: 1,
      status: "dismissed",
      updatedAt: 10,
    });

    await recordSystemProfileImport(
      { browser: "chrome", systemProfile: "Default", targetProfile: "imported" },
      20,
    );
    expect(await readSystemProfileImportState()).toEqual({
      version: 1,
      status: "imported",
      browser: "chrome",
      systemProfile: "Default",
      targetProfile: "imported",
      updatedAt: 20,
    });
  });

  it("reuses only the recorded target and otherwise avoids collisions", () => {
    expect(resolveSuggestedImportTarget({ profileNames: ["openclaw"] })).toBe("imported");
    expect(resolveSuggestedImportTarget({ profileNames: ["openclaw", "imported"] })).toBe(
      "imported-2",
    );
    expect(
      resolveSuggestedImportTarget({
        profileNames: ["openclaw", "imported", "imported-2"],
        state: {
          version: 1,
          status: "imported",
          browser: "chrome",
          systemProfile: "Default",
          targetProfile: "imported-2",
          updatedAt: 20,
        },
      }),
    ).toBe("imported-2");
  });
});
