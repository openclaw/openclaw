import { describe, expect, it } from "vitest";
import { buildCodexAppServerStdioSpawnOptions } from "./transport-stdio.js";

describe("Codex app-server stdio transport", () => {
  it("spawns through a shell on Windows so npm command shims resolve", () => {
    const options = buildCodexAppServerStdioSpawnOptions({}, "win32");

    expect(options).toEqual(
      expect.objectContaining({
        detached: false,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("keeps non-Windows spawns direct and detached", () => {
    const options = buildCodexAppServerStdioSpawnOptions({}, "darwin");

    expect(options).toEqual(
      expect.objectContaining({
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("applies environment overrides before clearing blocked keys", () => {
    const options = buildCodexAppServerStdioSpawnOptions(
      {
        env: {
          CODEX_HOME: "/tmp/openclaw-codex",
          CODEX_TEST_CLEAR_ME: "remove",
        },
        clearEnv: ["CODEX_TEST_CLEAR_ME"],
      },
      "darwin",
    );

    expect(options.env?.CODEX_HOME).toBe("/tmp/openclaw-codex");
    expect(options.env?.CODEX_TEST_CLEAR_ME).toBeUndefined();
  });
});
