import { describe, it, expect } from "vitest";
import { filterSecretsFromEnv, isSecretKey } from "./secret-filter.js";

describe("secret-filter", () => {
  describe("filterSecretsFromEnv", () => {
    it("strips known secret env vars", () => {
      const env = {
        OPENAI_API_KEY: "sk-xxx", // pragma: allowlist secret
        ANTHROPIC_API_KEY: "ant-xxx", // pragma: allowlist secret
        AWS_SECRET_ACCESS_KEY: "aws-xxx", // pragma: allowlist secret
        MY_APP_SECRET: "secret-val", // pragma: allowlist secret
        AUTH_TOKEN: "tok-xxx",
        PATH: "/usr/bin",
      };
      const filtered = filterSecretsFromEnv(env);
      expect(filtered).not.toHaveProperty("OPENAI_API_KEY");
      expect(filtered).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(filtered).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(filtered).not.toHaveProperty("MY_APP_SECRET");
      expect(filtered).not.toHaveProperty("AUTH_TOKEN");
      expect(filtered).toHaveProperty("PATH", "/usr/bin");
    });

    it("keeps allowlisted vars unconditionally", () => {
      const env = {
        PATH: "/usr/bin",
        HOME: "/home/user",
        USER: "testuser",
        NODE_ENV: "production",
        LANG: "en_US.UTF-8",
        TZ: "UTC",
      };
      const filtered = filterSecretsFromEnv(env);
      expect(filtered).toEqual(env);
    });

    it("keeps non-secret, non-allowlisted vars", () => {
      const env = {
        CUSTOM_VAR: "custom-value",
        MY_APP_PORT: "3000",
      };
      const filtered = filterSecretsFromEnv(env);
      expect(filtered).toHaveProperty("CUSTOM_VAR", "custom-value");
      expect(filtered).toHaveProperty("MY_APP_PORT", "3000");
    });

    it("returns empty object for all-secret input", () => {
      const env = {
        DB_PASSWORD: "pass123", // pragma: allowlist secret
        API_KEY: "key123", // pragma: allowlist secret
      };
      const filtered = filterSecretsFromEnv(env);
      expect(Object.keys(filtered)).toHaveLength(0);
    });
  });

  describe("isSecretKey", () => {
    it("detects API key patterns", () => {
      expect(isSecretKey("OPENAI_API_KEY")).toBe(true);
      expect(isSecretKey("API_KEY")).toBe(true);
    });

    it("detects password patterns", () => {
      expect(isSecretKey("DB_PASSWORD")).toBe(true);
    });

    it("detects token patterns", () => {
      expect(isSecretKey("AUTH_TOKEN")).toBe(true);
    });

    it("detects secret patterns", () => {
      expect(isSecretKey("MY_APP_SECRET")).toBe(true);
    });

    it("returns false for non-secret vars", () => {
      expect(isSecretKey("PATH")).toBe(false);
      expect(isSecretKey("HOME")).toBe(false);
      expect(isSecretKey("NODE_ENV")).toBe(false);
      expect(isSecretKey("CUSTOM_VAR")).toBe(false);
      expect(isSecretKey("MY_APP_PORT")).toBe(false);
    });
  });
});
