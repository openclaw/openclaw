import { describe, expect, it } from "vitest";
import { resolveSandboxDockerConfig } from "./config.js";

describe("resolveSandboxDockerConfig", () => {
  it("merges configEnvVars into sandbox docker env", () => {
    const result = resolveSandboxDockerConfig({
      scope: "agent",
      configEnvVars: { SUPADATA_API_KEY: "sk-test", MY_VAR: "hello" },
    });
    expect(result.env).toEqual({
      LANG: "C.UTF-8",
      SUPADATA_API_KEY: "sk-test",
      MY_VAR: "hello",
    });
  });

  it("globalDocker.env overrides configEnvVars", () => {
    const result = resolveSandboxDockerConfig({
      scope: "agent",
      configEnvVars: { SUPADATA_API_KEY: "from-config" },
      globalDocker: { env: { SUPADATA_API_KEY: "from-global-docker", OTHER: "val" } },
    });
    expect(result.env?.SUPADATA_API_KEY).toBe("from-global-docker");
    expect(result.env?.OTHER).toBe("val");
  });

  it("agentDocker.env overrides both configEnvVars and globalDocker.env", () => {
    const result = resolveSandboxDockerConfig({
      scope: "agent",
      configEnvVars: { SUPADATA_API_KEY: "from-config" },
      globalDocker: { env: { SUPADATA_API_KEY: "from-global" } },
      agentDocker: { env: { SUPADATA_API_KEY: "from-agent" } },
    });
    expect(result.env?.SUPADATA_API_KEY).toBe("from-agent");
  });

  it("works without configEnvVars (backwards compatible)", () => {
    const result = resolveSandboxDockerConfig({
      scope: "agent",
    });
    expect(result.env).toEqual({ LANG: "C.UTF-8" });
  });

  it("preserves LANG default when configEnvVars provided", () => {
    const result = resolveSandboxDockerConfig({
      scope: "agent",
      configEnvVars: { FOO: "bar" },
    });
    expect(result.env?.LANG).toBe("C.UTF-8");
    expect(result.env?.FOO).toBe("bar");
  });
});
