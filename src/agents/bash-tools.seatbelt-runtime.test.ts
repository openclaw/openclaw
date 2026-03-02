import { describe, expect, it } from "vitest";
import { buildSandboxEnv, buildSeatbeltExecArgs } from "./bash-tools.shared.js";

describe("seatbelt exec runtime helpers", () => {
  it("builds sandbox-exec args with profile and -D definitions", () => {
    const args = buildSeatbeltExecArgs({
      command: "echo hello",
      profilePath: "/tmp/seatbelt/demo-open.sb",
      definitions: {
        PROJECT_DIR: "/tmp/workspace",
        WORKSPACE_ACCESS: "ro",
      },
    });

    expect(args).toEqual([
      "-f",
      "/tmp/seatbelt/demo-open.sb",
      "-D",
      "PROJECT_DIR=/tmp/workspace",
      "-D",
      "WORKSPACE_ACCESS=ro",
      "sh",
      "-lc",
      "echo hello",
    ]);
  });

  it("keeps HOME pinned to the host home override", () => {
    const env = buildSandboxEnv({
      defaultPath: "/usr/bin",
      containerWorkdir: "/workspace",
      sandboxEnv: { LANG: "C.UTF-8", HOME: "/tmp/sandbox-home" },
      paramsEnv: { HOME: "/tmp/request-home", FOO: "bar" },
      homeOverride: "/Users/claw",
    });

    expect(env.HOME).toBe("/Users/claw");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
    expect(env.LANG).toBe("C.UTF-8");
  });

  it("does not inject proxy environment variables by default", () => {
    const env = buildSandboxEnv({
      defaultPath: "/usr/bin",
      containerWorkdir: "/workspace",
      homeOverride: "/Users/claw",
    });

    expect(env).not.toHaveProperty("HTTP_PROXY");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(env).not.toHaveProperty("ALL_PROXY");
    expect(env).not.toHaveProperty("NO_PROXY");
  });
});
