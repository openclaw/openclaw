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

  it("throws an actionable error on Linux when secret-tool fails", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:os")>();
      return { ...real, platform: () => "linux" };
    });
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], cb: (err: Error) => void) =>
        cb(new Error("secret-tool: not found")),
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
    ).rejects.toThrow(/Ensure secret-tool is installed/);
  });
});
