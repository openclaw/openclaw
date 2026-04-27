import { describe, expect, it, vi } from "vitest";
import { createKeyringSecretProvider } from "./secret-provider.js";

describe("secrets-keyring createKeyringSecretProvider", () => {
  it("declares id 'keyring' and a label", () => {
    const provider = createKeyringSecretProvider();
    expect(provider.id).toBe("keyring");
    expect(provider.label.length).toBeGreaterThan(0);
  });

  it("resolves on macOS via the security CLI (mocked)", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "darwin", homedir: () => "/Users/test" };
    });
    let receivedArgs: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => {
        receivedArgs = args;
        cb(null, { stdout: "the-keyring-value\n", stderr: "" });
      },
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    const out = await provider.resolve({
      refs: [{ source: "keyring", provider: "local", id: "slack-token" }],
      providerName: "local",
      providerConfig: { source: "keyring" },
      env: process.env,
    });
    expect(out.get("slack-token")).toBe("the-keyring-value");
    expect(receivedArgs).toContain("find-generic-password");
    expect(receivedArgs).toContain("slack-token");
    expect(receivedArgs).toContain("openclaw");
  });

  it("on macOS uses native Keychain semantics: -s for service config, -a for ref id", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "darwin", homedir: () => "/Users/test" };
    });
    let receivedArgs: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => {
        receivedArgs = args;
        cb(null, { stdout: "v\n", stderr: "" });
      },
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await provider.resolve({
      refs: [{ source: "keyring", provider: "local", id: "openai-api-key" }],
      providerName: "local",
      providerConfig: { source: "keyring", service: "openclaw" },
      env: process.env,
    });
    // Native macOS Keychain attribute mapping:
    //   `security add-generic-password -s <service> -a <account> -w <value>`
    // OpenClaw `service` config -> -s, OpenClaw ref id -> -a.
    const sIdx = receivedArgs.indexOf("-s");
    const aIdx = receivedArgs.indexOf("-a");
    expect(receivedArgs[sIdx + 1]).toBe("openclaw");
    expect(receivedArgs[aIdx + 1]).toBe("openai-api-key");
  });

  it("preserves trailing newlines in the stored secret value (only strips one CLI-added newline)", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "darwin", homedir: () => "/Users/test" };
    });
    // PEM-style: stored value ends with "\n", security adds another "\n" → "...END KEY-----\n\n".
    // We must return "...END KEY-----\n", not "...END KEY-----".
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: "-----BEGIN KEY-----\nbody\n-----END KEY-----\n\n", stderr: "" }),
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    const out = await provider.resolve({
      refs: [{ source: "keyring", provider: "local", id: "pem-key" }],
      providerName: "local",
      providerConfig: { source: "keyring" },
      env: process.env,
    });
    expect(out.get("pem-key")).toBe("-----BEGIN KEY-----\nbody\n-----END KEY-----\n");
  });

  it("uses a custom service name on macOS", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "darwin", homedir: () => "/Users/test" };
    });
    let receivedArgs: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        args: string[],
        cb: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => {
        receivedArgs = args;
        cb(null, { stdout: "v\n", stderr: "" });
      },
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await provider.resolve({
      refs: [{ source: "keyring", provider: "local", id: "k" }],
      providerName: "local",
      providerConfig: { source: "keyring", service: "myservice" },
      env: process.env,
    });
    expect(receivedArgs).toContain("myservice");
  });

  it("resolves on Linux via secret-tool (mocked)", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "linux" };
    });
    let receivedCmd = "";
    vi.doMock("node:child_process", () => ({
      execFile: (
        cmd: string,
        _args: string[],
        cb: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => {
        receivedCmd = cmd;
        cb(null, { stdout: "linux-value\n", stderr: "" });
      },
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    const out = await provider.resolve({
      refs: [{ source: "keyring", provider: "local", id: "x" }],
      providerName: "local",
      providerConfig: { source: "keyring" },
      env: process.env,
    });
    expect(out.get("x")).toBe("linux-value");
    expect(receivedCmd).toBe("secret-tool");
  });

  it("throws on unsupported platforms", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "win32" };
    });

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await expect(
      provider.resolve({
        refs: [{ source: "keyring", provider: "local", id: "x" }],
        providerName: "local",
        providerConfig: { source: "keyring" },
        env: process.env,
      }),
    ).rejects.toThrow(/not supported/);
  });

  it("throws an actionable error on Linux when secret-tool is not installed", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "linux" };
    });
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], cb: (err: Error) => void) => {
        const err = Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
        cb(err);
      },
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await expect(
      provider.resolve({
        refs: [{ source: "keyring", provider: "local", id: "x" }],
        providerName: "local",
        providerConfig: { source: "keyring" },
        env: process.env,
      }),
    ).rejects.toThrow(/libsecret.*was not found on PATH/);
  });

  it("throws a distinct error on Linux when the secret is missing", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "linux" };
    });
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: "", stderr: "" }),
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await expect(
      provider.resolve({
        refs: [{ source: "keyring", provider: "local", id: "x" }],
        providerName: "local",
        providerConfig: { source: "keyring" },
        env: process.env,
      }),
    ).rejects.toThrow(/not found in libsecret.*secret-tool store/);
  });

  describe("validateConfig", () => {
    const provider = createKeyringSecretProvider();

    it("rejects a service name starting with a dash (argv-injection guard)", () => {
      expect(() => provider.validateConfig?.({ source: "keyring", service: "-D" })).toThrow(
        /must not start with "-"/,
      );
    });

    it("rejects a service name with shell metacharacters", () => {
      expect(() =>
        provider.validateConfig?.({ source: "keyring", service: "evil; rm -rf /" }),
      ).toThrow(/must match/);
    });

    it("rejects a relative keychainPath", () => {
      expect(() =>
        provider.validateConfig?.({ source: "keyring", keychainPath: "openclaw.keychain-db" }),
      ).toThrow(/must be an absolute path/);
    });

    it("rejects a keychainPath that does not look like a keychain", () => {
      expect(() =>
        provider.validateConfig?.({ source: "keyring", keychainPath: "/etc/passwd" }),
      ).toThrow(/must end with/);
    });

    it("rejects a keychainPath starting with a dash", () => {
      expect(() =>
        provider.validateConfig?.({ source: "keyring", keychainPath: "-vfoo.keychain-db" }),
      ).toThrow(/must not start with "-"/);
    });

    it("rejects wrong source string", () => {
      expect(() => provider.validateConfig?.({ source: "env" })).toThrow(/config.source must be/);
    });

    it("accepts a minimal config with no overrides", () => {
      expect(() => provider.validateConfig?.({ source: "keyring" })).not.toThrow();
    });

    it("accepts a config with valid service and keychainPath", () => {
      expect(() =>
        provider.validateConfig?.({
          source: "keyring",
          service: "my_service",
          keychainPath: "/Users/test/Library/Keychains/custom.keychain-db",
        }),
      ).not.toThrow();
    });
  });

  it("resolve() rejects ref ids starting with a dash before spawning", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "linux" };
    });
    let spawnCalled = false;
    vi.doMock("node:child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        cb: (err: null, out: { stdout: string; stderr: string }) => void,
      ) => {
        spawnCalled = true;
        cb(null, { stdout: "should-not-reach-here\n", stderr: "" });
      },
    }));

    const { createKeyringSecretProvider: freshFactory } = await import("./secret-provider.js");
    const provider = freshFactory();
    await expect(
      provider.resolve({
        refs: [{ source: "keyring", provider: "local", id: "-vfoo" }],
        providerName: "local",
        providerConfig: { source: "keyring" },
        env: process.env,
      }),
    ).rejects.toThrow(/ref id .*must not start with "-"/);
    expect(spawnCalled).toBe(false);
  });
});
