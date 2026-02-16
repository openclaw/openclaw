import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { ensurePiAuthJsonFromAuthProfiles } from "./pi-auth-json.js";

describe("ensurePiAuthJsonFromAuthProfiles", () => {
  it("writes openai-codex oauth credentials into auth.json for pi-coding-agent discovery", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
    );

    const first = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(first.wrote).toBe(true);

    const authPath = path.join(agentDir, "auth.json");
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(auth["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
    });

    const second = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(second.wrote).toBe(false);
  });

  it("writes api_key credentials into auth.json", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            key: "sk-or-v1-test-key",
          },
        },
      },
      agentDir,
    );

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const authPath = path.join(agentDir, "auth.json");
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(auth["openrouter"]).toMatchObject({
      type: "api_key",
      key: "sk-or-v1-test-key",
    });
  });

  it("writes token credentials as api_key into auth.json", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "token",
            provider: "anthropic",
            token: "sk-ant-test-token",
          },
        },
      },
      agentDir,
    );

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const authPath = path.join(agentDir, "auth.json");
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(auth["anthropic"]).toMatchObject({
      type: "api_key",
      key: "sk-ant-test-token",
    });
  });

  it("syncs multiple providers at once", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            key: "sk-or-key",
          },
          "anthropic:default": {
            type: "token",
            provider: "anthropic",
            token: "sk-ant-token",
          },
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access",
            refresh: "refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
    );

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(true);

    const authPath = path.join(agentDir, "auth.json");
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;

    expect(auth["openrouter"]).toMatchObject({ type: "api_key", key: "sk-or-key" });
    expect(auth["anthropic"]).toMatchObject({ type: "api_key", key: "sk-ant-token" });
    expect(auth["openai-codex"]).toMatchObject({ type: "oauth", access: "access" });
  });

  it("skips profiles with empty keys", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            key: "",
          },
        },
      },
      agentDir,
    );

    const result = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(result.wrote).toBe(false);
  });

  it("preserves existing auth.json entries not in auth-profiles", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const authPath = path.join(agentDir, "auth.json");

    // Pre-populate auth.json with an entry
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({ "legacy-provider": { type: "api_key", key: "legacy-key" } }),
    );

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            key: "new-key",
          },
        },
      },
      agentDir,
    );

    await ensurePiAuthJsonFromAuthProfiles(agentDir);

    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(auth["legacy-provider"]).toMatchObject({ type: "api_key", key: "legacy-key" });
    expect(auth["openrouter"]).toMatchObject({ type: "api_key", key: "new-key" });
  });
});
