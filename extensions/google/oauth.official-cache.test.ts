import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  importOfficialGeminiCliOAuthCredentials,
  requireOfficialGeminiCliOAuthCredentials,
  resolveOfficialGeminiCliOAuthCachePath,
  setOfficialGeminiCliOAuthCacheFsForTest,
} from "./oauth.official-cache.js";

const HOME = "/mock/home";
const CACHE_PATH = join(HOME, ".gemini", "oauth_creds.json");
const ACCOUNTS_PATH = join(HOME, ".gemini", "google_accounts.json");

function installFiles(files: Record<string, string>) {
  setOfficialGeminiCliOAuthCacheFsForTest({
    homedir: () => HOME,
    existsSync: (path) => Object.hasOwn(files, String(path)),
    readFileSync: (path) => {
      const value = files[String(path)];
      if (value === undefined) {
        throw new Error(`Unexpected read: ${String(path)}`);
      }
      return value;
    },
  });
}

afterEach(() => {
  setOfficialGeminiCliOAuthCacheFsForTest();
});

describe("official Gemini CLI OAuth cache", () => {
  it("imports token material bound to the active Gemini CLI account", () => {
    installFiles({
      [CACHE_PATH]: JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: 1_800_000_000_000,
        id_token: "id-token",
        email: "User@Example.com",
      }),
      [ACCOUNTS_PATH]: JSON.stringify({ active: "user@example.com" }),
    });

    expect(
      requireOfficialGeminiCliOAuthCredentials({
        GOOGLE_CLOUD_PROJECT: "project-id",
      }),
    ).toEqual({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_800_000_000_000,
      idToken: "id-token",
      email: "user@example.com",
      projectId: "project-id",
      sourcePath: CACHE_PATH,
    });
  });

  it("honors GEMINI_CLI_HOME", () => {
    expect(
      resolveOfficialGeminiCliOAuthCachePath({ GEMINI_CLI_HOME: "/custom/home" }),
    ).toBe(join("/custom/home", ".gemini", "oauth_creds.json"));
  });

  it("fails closed when the active account identity is missing", () => {
    installFiles({
      [CACHE_PATH]: JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: 1_800_000_000_000,
      }),
    });

    expect(() => requireOfficialGeminiCliOAuthCredentials({})).toThrow(
      "Official Gemini CLI account identity was not found",
    );
    expect(importOfficialGeminiCliOAuthCredentials({})).toBeNull();
  });

  it("rejects an OAuth cache for a different active account", () => {
    installFiles({
      [CACHE_PATH]: JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: 1_800_000_000_000,
        email: "first@example.com",
      }),
      [ACCOUNTS_PATH]: JSON.stringify({ active: "second@example.com" }),
    });

    expect(() => requireOfficialGeminiCliOAuthCredentials({})).toThrow(
      "does not match active account",
    );
  });

  it("rejects incomplete token material", () => {
    installFiles({
      [CACHE_PATH]: JSON.stringify({ access_token: "access-token" }),
      [ACCOUNTS_PATH]: JSON.stringify({ active: "user@example.com" }),
    });

    expect(() => requireOfficialGeminiCliOAuthCredentials({})).toThrow(
      "missing token material",
    );
  });
});
