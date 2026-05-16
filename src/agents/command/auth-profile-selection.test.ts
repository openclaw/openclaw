import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "../auth-profiles/store.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveOrderedOpenAIPiAuthProfileSelection } from "./auth-profile-selection.js";

describe("resolveOrderedOpenAIPiAuthProfileSelection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-openai-pi-auth-selection-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("selects a Codex OAuth profile from OpenAI auth order for OpenAI Pi runs", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:work": {
          type: "oauth",
          provider: "openai-codex",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 60_000,
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai",
        },
      },
    };
    saveAuthProfileStore(store, tmpDir);

    const selection = resolveOrderedOpenAIPiAuthProfileSelection({
      config: {
        auth: {
          order: {
            openai: ["openai-codex:work", "openai:default"],
          },
        },
      },
      agentDir: tmpDir,
      workspaceDir: tmpDir,
      provider: "openai",
      harnessRuntime: "pi",
      allowHarnessAuthProfileForwarding: true,
    });

    expect(selection).toEqual({
      authProfileId: "openai-codex:work",
      authProfileIdSource: "auto",
      authProfileProvider: "openai-codex",
    });
  });

  it("does not skip an earlier OpenAI API-key profile to select a later Codex OAuth profile", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai",
        },
        "openai-codex:work": {
          type: "oauth",
          provider: "openai-codex",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    saveAuthProfileStore(store, tmpDir);

    expect(
      resolveOrderedOpenAIPiAuthProfileSelection({
        config: {
          auth: {
            order: {
              openai: ["openai:default", "openai-codex:work"],
            },
          },
        },
        agentDir: tmpDir,
        workspaceDir: tmpDir,
        provider: "openai",
        harnessRuntime: "pi",
        allowHarnessAuthProfileForwarding: true,
      }),
    ).toBeUndefined();
  });

  it("does not select Codex OAuth profiles for non-Pi OpenAI runs", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:work": {
          type: "oauth",
          provider: "openai-codex",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    saveAuthProfileStore(store, tmpDir);

    expect(
      resolveOrderedOpenAIPiAuthProfileSelection({
        config: {
          auth: {
            order: {
              openai: ["openai-codex:work"],
            },
          },
        },
        agentDir: tmpDir,
        workspaceDir: tmpDir,
        provider: "openai",
        harnessRuntime: "default",
        allowHarnessAuthProfileForwarding: true,
      }),
    ).toBeUndefined();
  });
});
