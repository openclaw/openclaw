import { describe, expect, it } from "vitest";
import {
  resolveSandboxBackend,
  resolveSandboxMicrovmConfig,
  resolveSandboxConfigForAgent,
} from "./sandbox.js";

describe("resolveSandboxBackend", () => {
  it("defaults to container when nothing is set", () => {
    expect(resolveSandboxBackend({})).toBe("container");
  });

  it("uses global backend when set", () => {
    expect(resolveSandboxBackend({ globalBackend: "microvm" })).toBe("microvm");
  });

  it("agent backend overrides global", () => {
    expect(resolveSandboxBackend({ globalBackend: "container", agentBackend: "microvm" })).toBe(
      "microvm",
    );
  });
});

describe("resolveSandboxMicrovmConfig", () => {
  it("returns defaults when nothing is set", () => {
    const result = resolveSandboxMicrovmConfig({ scope: "agent" });
    expect(result.sandboxPrefix).toBe("openclaw-vm-");
    expect(result.template).toBeUndefined();
    expect(result.env).toBeUndefined();
    expect(result.setupCommand).toBeUndefined();
  });

  it("merges global and agent env", () => {
    const result = resolveSandboxMicrovmConfig({
      scope: "agent",
      globalMicrovm: { env: { LANG: "C.UTF-8", FOO: "global" } },
      agentMicrovm: { env: { FOO: "agent", BAR: "baz" } },
    });
    expect(result.env).toEqual({
      LANG: "C.UTF-8",
      FOO: "agent",
      BAR: "baz",
    });
  });

  it("agent template overrides global", () => {
    const result = resolveSandboxMicrovmConfig({
      scope: "agent",
      globalMicrovm: { template: "debian:bookworm" },
      agentMicrovm: { template: "python:3-alpine" },
    });
    expect(result.template).toBe("python:3-alpine");
  });

  it("ignores agent overrides for shared scope", () => {
    const result = resolveSandboxMicrovmConfig({
      scope: "shared",
      globalMicrovm: { template: "debian:bookworm" },
      agentMicrovm: { template: "python:3-alpine" },
    });
    expect(result.template).toBe("debian:bookworm");
  });

  it("uses agent sandboxPrefix", () => {
    const result = resolveSandboxMicrovmConfig({
      scope: "session",
      agentMicrovm: { sandboxPrefix: "my-prefix-" },
    });
    expect(result.sandboxPrefix).toBe("my-prefix-");
  });
});

describe("resolveSandboxConfigForAgent with backend", () => {
  it("defaults backend to container for backwards compatibility", () => {
    const config = resolveSandboxConfigForAgent(undefined, undefined);
    expect(config.backend).toBe("container");
  });

  it("resolves microvm backend from global config", () => {
    const config = resolveSandboxConfigForAgent(
      {
        agents: {
          defaults: {
            sandbox: {
              backend: "microvm",
            },
          },
        },
      } as unknown,
      undefined,
    );
    expect(config.backend).toBe("microvm");
  });

  it("includes microvm config in resolved config", () => {
    const config = resolveSandboxConfigForAgent(
      {
        agents: {
          defaults: {
            sandbox: {
              backend: "microvm",
              microvm: {
                template: "python:3-alpine",
                sandboxPrefix: "test-vm-",
              },
            },
          },
        },
      } as unknown,
      undefined,
    );
    expect(config.backend).toBe("microvm");
    expect(config.microvm.template).toBe("python:3-alpine");
    expect(config.microvm.sandboxPrefix).toBe("test-vm-");
  });
});
