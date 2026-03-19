import { describe, expect, it } from "vitest";
import { buildSandboxEnv } from "./bash-tools.shared.js";

describe("buildSandboxEnv", () => {
  it("includes skillEnv in sandbox environment", () => {
    const env = buildSandboxEnv({
      defaultPath: "/usr/bin",
      skillEnv: { MY_API_KEY: "secret-123", CUSTOM_VAR: "value" },
      containerWorkdir: "/workspace",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/workspace");
    expect(env.MY_API_KEY).toBe("secret-123");
    expect(env.CUSTOM_VAR).toBe("value");
  });

  it("sandboxEnv overrides skillEnv", () => {
    const env = buildSandboxEnv({
      defaultPath: "/usr/bin",
      skillEnv: { SHARED: "from-skill" },
      sandboxEnv: { SHARED: "from-sandbox" },
      containerWorkdir: "/workspace",
    });

    expect(env.SHARED).toBe("from-sandbox");
  });

  it("paramsEnv overrides both skillEnv and sandboxEnv", () => {
    const env = buildSandboxEnv({
      defaultPath: "/usr/bin",
      skillEnv: { SHARED: "from-skill" },
      sandboxEnv: { SHARED: "from-sandbox" },
      paramsEnv: { SHARED: "from-params" },
      containerWorkdir: "/workspace",
    });

    expect(env.SHARED).toBe("from-params");
  });

  it("works without skillEnv", () => {
    const env = buildSandboxEnv({
      defaultPath: "/usr/bin",
      containerWorkdir: "/workspace",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/workspace");
    expect(Object.keys(env)).toHaveLength(2);
  });
});
