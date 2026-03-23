import { describe, expect, it } from "vitest";
import { redactImageDataForDiagnostics } from "./payload-redaction.js";

describe("payload-redaction", () => {
  describe("redactImageDataForDiagnostics", () => {
    it("should redact apiKey field", () => {
      const input = {
        apiKey: "sk-ant-secret-key-12345",
        model: "test-model",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.apiKey).toBe("[REDACTED]");
      expect(result.model).toBe("test-model");
    });

    it("should redact token field", () => {
      const input = {
        token: "secret-token-value",
        baseURL: "https://api.example.com",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.token).toBe("[REDACTED]");
      expect(result.baseURL).toBe("https://api.example.com");
    });

    it("should redact password field", () => {
      const input = {
        password: "super-secret-password",
        username: "user",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.password).toBe("[REDACTED]");
      expect(result.username).toBe("user");
    });

    it("should redact secretKey field", () => {
      const input = {
        secretKey: "aws-secret-key-123",
        accessKey: "aws-access-key",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.secretKey).toBe("[REDACTED]");
      expect(result.accessKey).toBe("aws-access-key");
    });

    it("should redact authorization field", () => {
      const input = {
        authorization: "Bearer secret-bearer-token",
        endpoint: "https://api.example.com",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.authorization).toBe("[REDACTED]");
      expect(result.endpoint).toBe("https://api.example.com");
    });

    it("should redact bearerToken and refreshToken fields", () => {
      const input = {
        bearerToken: "secret-bearer",
        refreshToken: "refresh-123",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.bearerToken).toBe("[REDACTED]");
      expect(result.refreshToken).toBe("[REDACTED]");
    });

    it("should redact clientSecret field", () => {
      const input = {
        clientSecret: "oauth-client-secret",
        clientId: "client-id-123",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.clientSecret).toBe("[REDACTED]");
      expect(result.clientId).toBe("client-id-123");
    });

    it("should redact accessToken field", () => {
      const input = {
        accessToken: "access-token-123",
        expiresIn: 3600,
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.accessToken).toBe("[REDACTED]");
      expect(result.expiresIn).toBe(3600);
    });

    it("should redact apiSecret field", () => {
      const input = {
        apiSecret: "api-secret-value",
        apiKey: "api-key-value",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.apiSecret).toBe("[REDACTED]");
      expect(result.apiKey).toBe("[REDACTED]");
    });

    it("should redact secret field", () => {
      const input = {
        secret: "top-secret-value",
        public: "public-value",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.secret).toBe("[REDACTED]");
      expect(result.public).toBe("public-value");
    });

    it("should redact multiple credential fields at once", () => {
      const input = {
        apiKey: "sk-ant-123",
        token: "token-456",
        password: "pass-789",
        model: "test-model",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.apiKey).toBe("[REDACTED]");
      expect(result.token).toBe("[REDACTED]");
      expect(result.password).toBe("[REDACTED]");
      expect(result.model).toBe("test-model");
    });

    it("should handle nested objects with credentials", () => {
      const input = {
        options: {
          apiKey: "nested-api-key",
          model: "nested-model",
        },
        topLevel: "value",
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect((result.options as Record<string, unknown>).apiKey).toBe("[REDACTED]");
      expect((result.options as Record<string, unknown>).model).toBe("nested-model");
      expect(result.topLevel).toBe("value");
    });

    it("should handle arrays with credential objects", () => {
      const input = {
        providers: [
          { name: "openai", apiKey: "sk-openai-123" },
          { name: "anthropic", apiKey: "sk-ant-456" },
        ],
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      const providers = result.providers as Array<Record<string, unknown>>;
      expect(providers[0].name).toBe("openai");
      expect(providers[0].apiKey).toBe("[REDACTED]");
      expect(providers[1].name).toBe("anthropic");
      expect(providers[1].apiKey).toBe("[REDACTED]");
    });

    it("should preserve non-credential fields", () => {
      const input = {
        apiKey: "secret",
        model: "gpt-4",
        baseURL: "https://api.openai.com",
        temperature: 0.7,
        maxTokens: 1000,
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.apiKey).toBe("[REDACTED]");
      expect(result.model).toBe("gpt-4");
      expect(result.baseURL).toBe("https://api.openai.com");
      expect(result.temperature).toBe(0.7);
      expect(result.maxTokens).toBe(1000);
    });

    it("should handle undefined and null values", () => {
      const input = {
        apiKey: "secret",
        undefinedField: undefined,
        nullField: null,
      };

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.apiKey).toBe("[REDACTED]");
      expect(result.undefinedField).toBeUndefined();
      expect(result.nullField).toBeNull();
    });

    it("should handle circular references", () => {
      const input: Record<string, unknown> = {
        apiKey: "secret",
        name: "test",
      };
      input.self = input;

      const result = redactImageDataForDiagnostics(input) as Record<string, unknown>;

      expect(result.apiKey).toBe("[REDACTED]");
      expect(result.name).toBe("test");
      expect(result.self).toBe("[Circular]");
    });
  });
});
