import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { prepareCliModelCatalog } from "./prepared-cli-model-catalog.js";

const model = { provider: "fixture", id: "new-model", name: "New model" };

function context(plugin: CliBackendPlugin) {
  return {
    catalog: { entries: [model], routeVariants: [model] },
    backends: [plugin],
    config: {} as OpenClawConfig,
    authModes: { "fixture-cli": "token" } as PreparedAgentCredentialModes,
    configuredModelRefs: [{ provider: "fixture", modelId: "new-model" }],
    env: { PATH: "/service/bin", REMOVED: "value" },
    cwd: "/service/workspace",
    reason: "discovery" as const,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  };
}

function backend(
  prepareModelCatalog: NonNullable<CliBackendPlugin["prepareModelCatalog"]>,
): CliBackendPlugin {
  return {
    id: "fixture-cli",
    modelProvider: "fixture",
    config: { command: "/service/bin/fixture", env: { OWNED: "value" }, clearEnv: ["REMOVED"] },
    prepareModelCatalog,
  };
}

describe("prepared CLI model compatibility", () => {
  it("passes only the registered launch environment and fails closed for omitted models", async () => {
    const prepare = vi.fn<NonNullable<CliBackendPlugin["prepareModelCatalog"]>>(async () => ({
      models: {},
      nextCheckAt: 123,
    }));
    const configured = backend(prepare);
    configured.normalizeConfig = (config) => ({
      ...config,
      command: "/service/custom-fixture",
      env: { ...config.env, PATH: "/caller/bin" },
    });
    const result = await prepareCliModelCatalog(context(configured));
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      command: "/service/custom-fixture",
      env: { PATH: "/service/bin", OWNED: "value" },
      cwd: "/service/workspace",
      modelIds: ["new-model"],
      reason: "discovery",
    });
    expect(prepare.mock.calls[0]?.[0].env).not.toHaveProperty("REMOVED");
    expect(result["fixture-cli"]?.models["new-model"]).toMatchObject({ available: false });
    expect(result["fixture-cli"]?.nextCheckAt).toBe(123);
  });

  it.each(["api_key", "oauth", "token"] as const)(
    "does not maintain an unrelated CLI for provider-only %s auth",
    async (mode) => {
      const prepare = vi.fn(async () => ({ models: {} }));
      const fixture = context({ ...backend(prepare), subscriptionAuthDispatch: true });
      fixture.authModes = { fixture: mode };
      expect(await prepareCliModelCatalog(fixture)).toEqual({});
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["oauth", "token"] as const)(
    "prepares a subscription-dispatch backend with captured CLI %s auth",
    async (mode) => {
      const prepare = vi.fn(async () => ({ models: { "new-model": { available: true } } }));
      const fixture = context({ ...backend(prepare), subscriptionAuthDispatch: true });
      fixture.authModes = { "fixture-cli": mode };
      const result = await prepareCliModelCatalog(fixture);
      expect(prepare).toHaveBeenCalledOnce();
      expect(result["fixture-cli"]?.models["new-model"]?.available).toBe(true);
    },
  );

  it.each(["alias", "policy"] as const)(
    "prepares an explicitly configured CLI %s without a captured native credential",
    async (selection) => {
      const prepare = vi.fn(async () => ({ models: { "new-model": { available: true } } }));
      const fixture = context(backend(prepare));
      fixture.authModes = {};
      if (selection === "alias") {
        fixture.configuredModelRefs = [{ provider: "fixture-cli", modelId: "new-model" }];
      } else {
        fixture.config = {
          models: {
            providers: {
              fixture: {
                baseUrl: "https://fixture.invalid",
                models: [],
                agentRuntime: { id: "fixture-cli" },
              },
            },
          },
        };
      }
      const result = await prepareCliModelCatalog(fixture);
      expect(prepare).toHaveBeenCalledOnce();
      expect(result["fixture-cli"]?.models["new-model"]?.available).toBe(true);
    },
  );

  it("retains a failed repair as unavailable with a bounded renewal deadline", async () => {
    const fixture = context(
      backend(async () => {
        throw new Error("Update the fixture package with its installer.");
      }),
    );
    fixture.catalog.entries.push({ provider: "unrelated", id: "other", name: "Other" });
    const before = Date.now();
    const result = await prepareCliModelCatalog(fixture);
    const after = Date.now();
    expect(result).toEqual({
      "fixture-cli": {
        nextCheckAt: expect.any(Number),
        models: {
          "new-model": {
            available: false,
            reason: "Update the fixture package with its installer.",
          },
        },
      },
    });
    expect(result["fixture-cli"]!.nextCheckAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(result["fixture-cli"]!.nextCheckAt).toBeLessThanOrEqual(after + 60_000);
  });

  it("rejects an observation after its service owner retires", async () => {
    let current = true;
    const fixture = context(
      backend(async () => {
        current = false;
        return { models: { "new-model": { available: true } } };
      }),
    );
    fixture.assertCurrent = () => {
      if (!current) {
        throw new Error("retired catalog");
      }
    };
    await expect(prepareCliModelCatalog(fixture)).rejects.toThrow("retired catalog");
  });

  it("does not invoke maintenance after cancellation", async () => {
    const prepare = vi.fn(async () => ({ models: {} }));
    const fixture = context(backend(prepare));
    fixture.signal = AbortSignal.abort(new Error("catalog cancelled"));
    await expect(prepareCliModelCatalog(fixture)).rejects.toThrow("catalog cancelled");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("propagates cancellation during a failed preparation without scheduling renewal", async () => {
    const abort = new AbortController();
    const fixture = context(
      backend(async () => {
        abort.abort(new Error("catalog cancelled during preparation"));
        throw new Error("interrupted probe");
      }),
    );
    fixture.signal = abort.signal;
    await expect(prepareCliModelCatalog(fixture)).rejects.toThrow(
      "catalog cancelled during preparation",
    );
  });
});
