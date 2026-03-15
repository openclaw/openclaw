import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenSandboxConfig, OpenSandboxBackend } from "./backend-opensandbox.js";

// ---------------------------------------------------------------------------
// resolveOpenSandboxConfig
// ---------------------------------------------------------------------------

describe("resolveOpenSandboxConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env after each test.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("resolves from explicit settings", () => {
    const config = resolveOpenSandboxConfig({
      execdUrl: "http://sandbox:44772",
      accessToken: "tok-1",
      timeoutSec: 60,
    });
    expect(config.execdUrl).toBe("http://sandbox:44772");
    expect(config.accessToken).toBe("tok-1");
    expect(config.timeoutSec).toBe(60);
  });

  it("resolves from environment variables", () => {
    process.env.OPEN_SANDBOX_EXECD_URL = "http://env-host:9999";
    process.env.OPEN_SANDBOX_EXECD_ACCESS_TOKEN = "env-tok";

    const config = resolveOpenSandboxConfig({});
    expect(config.execdUrl).toBe("http://env-host:9999");
    expect(config.accessToken).toBe("env-tok");
  });

  it("explicit settings override env vars", () => {
    process.env.OPEN_SANDBOX_EXECD_URL = "http://env-host:9999";

    const config = resolveOpenSandboxConfig({
      execdUrl: "http://explicit:1234",
    });
    expect(config.execdUrl).toBe("http://explicit:1234");
  });

  it("defaults timeoutSec to 1800", () => {
    const config = resolveOpenSandboxConfig({
      execdUrl: "http://localhost:44772",
    });
    expect(config.timeoutSec).toBe(1800);
  });

  it("throws when no execd URL or lifecycle URL is available", () => {
    delete process.env.OPEN_SANDBOX_EXECD_URL;
    delete process.env.OPEN_SANDBOX_LIFECYCLE_URL;

    expect(() => resolveOpenSandboxConfig({})).toThrow(/requires either opensandbox\.execdUrl/);
  });

  it("throws when lifecycle URL is set but no sandbox ID", () => {
    process.env.OPEN_SANDBOX_LIFECYCLE_URL = "http://lifecycle:8080";
    delete process.env.OPEN_SANDBOX_SANDBOX_ID;

    expect(() => resolveOpenSandboxConfig({})).toThrow(/requires OPEN_SANDBOX_SANDBOX_ID/);
  });

  it("constructs execd URL from lifecycle URL + sandbox ID", () => {
    process.env.OPEN_SANDBOX_LIFECYCLE_URL = "http://lifecycle-host:8080";
    process.env.OPEN_SANDBOX_SANDBOX_ID = "sbx-abc";
    process.env.OPEN_SANDBOX_API_KEY = "api-key-1";

    const config = resolveOpenSandboxConfig({});
    expect(config.execdUrl).toBe("http://lifecycle-host:44772");
    expect(config.accessToken).toBe("api-key-1");
  });

  it("uses custom execd port in lifecycle discovery", () => {
    const config = resolveOpenSandboxConfig({
      lifecycleUrl: "http://lc-host:8080",
      sandboxId: "sbx-1",
      execdPort: 55555,
    });
    expect(config.execdUrl).toBe("http://lc-host:55555");
  });
});

// ---------------------------------------------------------------------------
// OpenSandboxBackend
// ---------------------------------------------------------------------------

describe("OpenSandboxBackend", () => {
  it("has kind=opensandbox", () => {
    const backend = new OpenSandboxBackend({
      execdUrl: "http://localhost:44772",
      timeoutSec: 30,
    });
    expect(backend.kind).toBe("opensandbox");
  });

  it("destroy is a no-op for direct connections", async () => {
    const backend = new OpenSandboxBackend({
      execdUrl: "http://localhost:44772",
      timeoutSec: 30,
    });
    // Should not throw.
    await backend.destroy();
  });

  it("exec calls client with wait=true", async () => {
    // We test this via the real HTTP path in opensandbox-client.test.ts.
    // Here we just verify the backend instance is constructable and has the
    // right interface shape.
    const backend = new OpenSandboxBackend({
      execdUrl: "http://localhost:44772",
      accessToken: "test",
      timeoutSec: 60,
    });

    expect(typeof backend.exec).toBe("function");
    expect(typeof backend.execAsync).toBe("function");
    expect(typeof backend.pollSession).toBe("function");
    expect(typeof backend.readOutput).toBe("function");
    expect(typeof backend.killSession).toBe("function");
    expect(typeof backend.destroy).toBe("function");
  });
});
