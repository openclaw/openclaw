// Openshell tests cover backend plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMirrorUploadCliParams,
  buildOpenShellSandboxName,
  buildOpenShellSshExecEnv,
} from "./backend.js";

describe("openshell backend env", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("filters blocked secrets from ssh exec env", () => {
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret";
    process.env.LANG = "en_US.UTF-8";
    process.env.NODE_ENV = "test";

    const env = buildOpenShellSshExecEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.NODE_ENV).toBe("test");
  });
});

describe("openshell sandbox names", () => {
  it("generates Kubernetes-safe names from OpenClaw session scope keys", () => {
    const name = buildOpenShellSandboxName("agent:somalley_alice:dashboard-8");

    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(name).toContain("somalley-alice");
    expect(name).not.toContain("_");
    expect(name.length).toBeLessThanOrEqual(63);
  });
});

describe("openshell mirror upload params", () => {
  it("uses '.' as upload source to prevent directory nesting", () => {
    const { args, cwd } = buildMirrorUploadCliParams({
      sandboxName: "test-sandbox-abc123",
      cwd: "/tmp/openclaw-openshell-upload-xyz",
      remotePath: "/sandbox",
    });

    // OpenShell >= v0.0.37 preserves named-source basenames as
    // subdirectories.  Passing "." with an explicit cwd avoids the
    // staged temp-dir basename nesting inside the remote workspace.
    expect(args[4]).toBe(".");
    expect(cwd).toBe("/tmp/openclaw-openshell-upload-xyz");
  });

  it("places staged contents under the target remote directory", () => {
    const { args } = buildMirrorUploadCliParams({
      sandboxName: "test-sandbox-def456",
      cwd: "/tmp/staging-dir",
      remotePath: "/agent",
    });

    expect(args[0]).toBe("sandbox");
    expect(args[1]).toBe("upload");
    expect(args[2]).toBe("--no-git-ignore");
    expect(args[3]).toBe("test-sandbox-def456");
    expect(args[5]).toBe("/agent");
  });
});
