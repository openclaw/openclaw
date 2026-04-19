import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProvidersForModelsJsonWithDeps } from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

describe("models-config.plan", () => {
  describe("resolveProvidersForModelsJsonWithDeps", () => {
    it("skips implicit provider discovery when models.mode is replace", async () => {
      const resolveImplicitProviders = vi.fn<
        typeof import("./models-config.providers.js").resolveImplicitProviders
      >(async () => ({
        openai: {
          apiKey: "implicit-key-from-plugin",
          models: [{ id: "gpt-4", name: "GPT-4" }],
        } satisfies ProviderConfig,
      }));

      const cfg: OpenClawConfig = {
        models: {
          mode: "replace",
          providers: {
            openai: {
              apiKey: "explicit-key",
            },
          },
        },
      };

      const result = await resolveProvidersForModelsJsonWithDeps(
        {
          cfg,
          agentDir: "/tmp/agent",
          env: process.env,
        },
        { resolveImplicitProviders },
      );

      // Should NOT call resolveImplicitProviders when mode is replace
      expect(resolveImplicitProviders).not.toHaveBeenCalled();

      // Should return only explicit providers
      expect(result).toEqual({
        openai: {
          apiKey: "explicit-key",
        },
      });
    });

    it("loads implicit providers when models.mode is merge", async () => {
      const resolveImplicitProviders = vi.fn<
        typeof import("./models-config.providers.js").resolveImplicitProviders
      >(async () => ({
        anthropic: {
          apiKey: "implicit-key",
          models: [{ id: "claude-3", name: "Claude 3" }],
        } satisfies ProviderConfig,
      }));

      const cfg: OpenClawConfig = {
        models: {
          mode: "merge",
          providers: {
            openai: {
              apiKey: "explicit-key",
            },
          },
        },
      };

      const result = await resolveProvidersForModelsJsonWithDeps(
        {
          cfg,
          agentDir: "/tmp/agent",
          env: process.env,
        },
        { resolveImplicitProviders },
      );

      // Should call resolveImplicitProviders when mode is merge
      expect(resolveImplicitProviders).toHaveBeenCalled();

      // Should merge explicit and implicit providers
      expect(result.openai).toEqual({ apiKey: "explicit-key" });
      expect(result.anthropic).toEqual({
        apiKey: "implicit-key",
        models: [{ id: "claude-3", name: "Claude 3" }],
      });
    });

    it("loads implicit providers when models.mode is undefined (defaults to merge)", async () => {
      const resolveImplicitProviders = vi.fn<
        typeof import("./models-config.providers.js").resolveImplicitProviders
      >(async () => ({
        anthropic: {
          apiKey: "implicit-key",
        } satisfies ProviderConfig,
      }));

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              apiKey: "explicit-key",
            },
          },
        },
      };

      const result = await resolveProvidersForModelsJsonWithDeps(
        {
          cfg,
          agentDir: "/tmp/agent",
          env: process.env,
        },
        { resolveImplicitProviders },
      );

      // Should call resolveImplicitProviders when mode is undefined (defaults to merge behavior)
      expect(resolveImplicitProviders).toHaveBeenCalled();
      expect(result.anthropic).toEqual({ apiKey: "implicit-key" });
    });
  });
});
