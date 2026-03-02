import { describe, expect, it } from "vitest";
import { sanitizeSkillEnvOverrides } from "./env-overrides.js";

describe("sanitizeSkillEnvOverrides", () => {
  describe("userConfiguredKeys bypass", () => {
    it("allows user-configured env vars matching _PASSWORD pattern in second loop", () => {
      // Env vars matching _PASSWORD get blocked by sanitizeEnvVars
      // but should be allowed if user configured them in skill.env
      const result = sanitizeSkillEnvOverrides({
        overrides: {
          GOG_KEYRING_PASSWORD: "secret123",
        },
        allowedSensitiveKeys: new Set(),
        userConfiguredKeys: new Set(["GOG_KEYRING_PASSWORD"]),
      });

      expect(result.allowed).toEqual({
        GOG_KEYRING_PASSWORD: "secret123",
      });
      expect(result.blocked).toEqual([]);
    });

    it("allows user-configured env vars matching isAlwaysBlockedSkillEnvKey in first loop", () => {
      // Env vars like OPENSSL_CONF are blocked by isAlwaysBlockedSkillEnvKey
      // They pass sanitizeEnvVars but get blocked in first loop
      // User-configured keys should bypass this check
      const result = sanitizeSkillEnvOverrides({
        overrides: {
          OPENSSL_CONF: "/custom/openssl.cnf",
        },
        allowedSensitiveKeys: new Set(),
        userConfiguredKeys: new Set(["OPENSSL_CONF"]),
      });

      expect(result.allowed).toEqual({
        OPENSSL_CONF: "/custom/openssl.cnf",
      });
      expect(result.blocked).toEqual([]);
    });

    it("allows user-configured env vars matching DYLD_ prefix in first loop", () => {
      // DYLD_* prefix is blocked by isDangerousHostEnvVarName
      // User-configured keys should bypass this
      const result = sanitizeSkillEnvOverrides({
        overrides: {
          DYLD_CUSTOM_VAR: "somevalue",
        },
        allowedSensitiveKeys: new Set(),
        userConfiguredKeys: new Set(["DYLD_CUSTOM_VAR"]),
      });

      expect(result.allowed).toEqual({
        DYLD_CUSTOM_VAR: "somevalue",
      });
      expect(result.blocked).toEqual([]);
    });

    it("still blocks dangerous env vars that are NOT user-configured", () => {
      const result = sanitizeSkillEnvOverrides({
        overrides: {
          OPENSSL_CONF: "/custom/openssl.cnf",
          DYLD_INSERT_LIBRARIES: "/evil.dylib",
        },
        allowedSensitiveKeys: new Set(),
        userConfiguredKeys: new Set(), // Not configured by user
      });

      expect(result.allowed).toEqual({});
      expect(result.blocked).toEqual(
        expect.arrayContaining(["OPENSSL_CONF", "DYLD_INSERT_LIBRARIES"]),
      );
    });

    it("allows non-dangerous env vars without userConfiguredKeys", () => {
      const result = sanitizeSkillEnvOverrides({
        overrides: {
          NODE_ENV: "development",
          CUSTOM_VAR: "value",
        },
        allowedSensitiveKeys: new Set(),
        userConfiguredKeys: new Set(),
      });

      expect(result.allowed).toEqual({
        NODE_ENV: "development",
        CUSTOM_VAR: "value",
      });
      expect(result.blocked).toEqual([]);
    });
  });
});
