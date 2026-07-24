import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasAuthProfileStoreSourceForProvider } from "./source-check.js";

describe("hasAuthProfileStoreSourceForProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function writeStoreFile(storePath: string, content: string, symlink?: boolean) {
    if (!symlink) {
      await fsp.writeFile(storePath, content);
      return;
    }
    // Dotfile-manager style installs link the store to a target outside the
    // agent dir; credential discovery must keep following those links.
    const target = path.join(path.dirname(storePath), "..", `linked-${path.basename(storePath)}`);
    await fsp.writeFile(target, content);
    await fsp.symlink(target, storePath);
  }

  async function withAgentStore(profiles: Record<string, unknown>, opts?: { symlink?: boolean }) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-source-"));
    const stateDir = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    await fsp.mkdir(agentDir, { recursive: true });
    await fsp.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await writeStoreFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles }),
      opts?.symlink,
    );
    return { agentDir };
  }

  async function withLegacyAuthStore(
    profiles: Record<string, unknown>,
    opts?: { symlink?: boolean },
  ) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-source-"));
    const stateDir = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    await fsp.mkdir(agentDir, { recursive: true });
    await fsp.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await writeStoreFile(path.join(agentDir, "auth.json"), JSON.stringify(profiles), opts?.symlink);
    return { agentDir };
  }

  it("counts provider-specific usable credentials", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
  });

  it("counts legacy auth stores with alias fields and fallback providers", async () => {
    const { agentDir } = await withLegacyAuthStore({
      openai: { mode: "apiKey", apiKey: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
  });

  it("follows symlinked auth-profiles.json stores", async () => {
    const { agentDir } = await withAgentStore(
      { "openai:default": { type: "api_key", provider: "openai", key: "sk-test" } },
      { symlink: true },
    );

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
  });

  it("follows symlinked legacy auth.json stores", async () => {
    const { agentDir } = await withLegacyAuthStore(
      { openai: { mode: "apiKey", apiKey: "sk-test" } },
      { symlink: true },
    );

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
  });

  it("ignores malformed provider fields instead of throwing", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", key: "sk-test" },
      "openai:other": { type: "api_key", provider: 123, key: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("does not count profile ids that are bound to a different credential provider", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("honors configured profile order constraints", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
      "openai:expired": {
        type: "token",
        provider: "openai",
        token: "expired-token",
        expires: Date.now() - 1000,
      },
    });

    expect(
      hasAuthProfileStoreSourceForProvider("openai", agentDir, {
        profileIds: ["openai:expired"],
      }),
    ).toBe(false);
    expect(
      hasAuthProfileStoreSourceForProvider("openai", agentDir, {
        profileIds: ["openai:default"],
      }),
    ).toBe(true);
  });

  it("treats explicit empty profile order as no usable profile", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
    });

    expect(
      hasAuthProfileStoreSourceForProvider("openai", agentDir, {
        profileIds: [],
      }),
    ).toBe(false);
  });

  it("does not count empty provider profiles as credential evidence", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("does not count expired token profiles as credential evidence", async () => {
    const { agentDir } = await withAgentStore({
      "openai:token": {
        type: "token",
        provider: "openai",
        token: "expired-token",
        expires: Date.now() - 1000,
      },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("treats oversized auth-profiles.json as having no credentials", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-source-"));
    const stateDir = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    await fsp.mkdir(agentDir, { recursive: true });
    await fsp.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    // Write an auth-profiles.json exceeding the 10 MiB internal limit.
    const largeContent = Buffer.alloc(11 * 1024 * 1024);
    // Inject valid JSON at the start so the file is at least parseable if read.
    const header = JSON.stringify({
      version: 1,
      profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-test" } },
    });
    largeContent.set(Buffer.from(header, "utf8"), 0);
    await fsp.writeFile(path.join(agentDir, "auth-profiles.json"), largeContent);

    // The oversized file is silently skipped — no credentials detected.
    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("treats oversized legacy auth.json as having no credentials", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-source-"));
    const stateDir = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    await fsp.mkdir(agentDir, { recursive: true });
    await fsp.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const largeContent = Buffer.alloc(11 * 1024 * 1024);
    const header = JSON.stringify({ openai: { mode: "apiKey", apiKey: "sk-test" } });
    largeContent.set(Buffer.from(header, "utf8"), 0);
    await fsp.writeFile(path.join(agentDir, "auth.json"), largeContent);

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });
});
