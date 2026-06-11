import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import setupEntry from "./setup-api.js";

describe("google setup entry", () => {
  it("registers setup runtime providers declared by the manifest", () => {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    setupEntry.register({
      registerProvider(provider: ProviderPlugin) {
        providerIds.push(provider.id);
      },
      registerCliBackend(backend: CliBackendPlugin) {
        cliBackendIds.push(backend.id);
      },
    } as never);

    expect(providerIds).toEqual(["google-vertex"]);
    expect(cliBackendIds).toEqual(["google-gemini-cli"]);
  });
});

describe("google gemini cli backend auth bridge", () => {
  it("materializes selected OpenClaw OAuth credentials into an isolated Gemini CLI home", async () => {
    const backend = buildGoogleGeminiCliBackend();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-workspace-"));
    let prepared:
      | Awaited<ReturnType<NonNullable<typeof backend.prepareExecution>>>
      | null
      | undefined;
    let home: string | undefined;

    try {
      prepared = await backend.prepareExecution?.({
        workspaceDir,
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        authProfileId: "google-gemini-cli:user@example.test",
        // Private bundled-runtime bridge, not public Plugin SDK surface.
        authCredential: {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: 1_800_000_000_000,
          idToken: "id-token",
          email: "user@example.test",
        },
      } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
        authCredential: {
          type: "oauth";
          provider: "google-gemini-cli";
          access: string;
          refresh: string;
          expires: number;
          idToken: string;
          email: string;
        };
      });

      home = prepared?.env?.GEMINI_CLI_HOME;
      expect(home).toBeTruthy();

      const raw = await fs.readFile(path.join(home ?? "", ".gemini", "oauth_creds.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        expiry_date: 1_800_000_000_000,
        token_type: "Bearer",
      });
    } finally {
      await prepared?.cleanup?.();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }

    await expect(fs.access(home ?? "")).rejects.toThrow();
  });

  it("uses profile-only auth epochs for the private Gemini CLI bridge", () => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.authEpochMode).toBe("profile-only");
    expect(backend.prepareExecution).toBeTypeOf("function");
  });
});
