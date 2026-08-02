import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHarnessSupportContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { createClaudeAppServerAgentHarness } from "../claude/harness.js";
import {
  CLAUDE_APP_SERVER_CONFIG_KEYS,
  CLAUDE_DYNAMIC_TOOLS_CONFIG_KEYS,
  claudeAppServerPoolKey,
  DEFAULT_CLAUDE_APP_SERVER_MODEL_PROVIDER,
  resolveClaudeAppServerConfig,
} from "../claude/src/app-server/config.js";
import { applyGlmDefaults, DEFAULT_ZAI_BASE_URL } from "./index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(HERE, "openclaw.plugin.json");

type ManifestConfigObject = {
  properties?: Record<string, ManifestConfigObject>;
};

/**
 * These tests pin the "GLM reuses the Claude bridge" contract — the entire
 * point of this single-file extension (openclaw-6mt / GLM review G1). The
 * load-bearing invariant is that a GLM turn resolves to a DISTINCT pool key
 * (`claude-bridge:zai`) so it runs in its own bridge process concurrently
 * with real Claude (openclaw-7ss). A refactor of applyGlmDefaults's spread
 * order or of the pool-key derivation could silently collapse both
 * extensions onto one process; these tests are the regression guard.
 */

function supportCtx(provider: string): AgentHarnessSupportContext {
  // supports() only reads ctx.provider; the rest of the context is irrelevant
  // to the provider-gate decision under test.
  return { provider, requestedRuntime: "claude-bridge" } as unknown as AgentHarnessSupportContext;
}

describe("applyGlmDefaults", () => {
  it("merges modelProvider=zai + Z.ai base URL onto a bare install", () => {
    const merged = applyGlmDefaults(undefined) as {
      appServer: { modelProvider: string; env: Record<string, string> };
    };
    expect(merged.appServer.modelProvider).toBe("zai");
    expect(merged.appServer.env.ANTHROPIC_BASE_URL).toBe(DEFAULT_ZAI_BASE_URL);
  });

  it("does not clobber an operator's explicit modelProvider / base URL override", () => {
    const merged = applyGlmDefaults({
      appServer: {
        modelProvider: "custom-provider",
        env: { ANTHROPIC_BASE_URL: "https://proxy.example/anthropic" },
      },
    }) as { appServer: { modelProvider: string; env: Record<string, string> } };
    expect(merged.appServer.modelProvider).toBe("custom-provider");
    expect(merged.appServer.env.ANTHROPIC_BASE_URL).toBe("https://proxy.example/anthropic");
  });

  it("preserves other operator env keys while defaulting the base URL", () => {
    const merged = applyGlmDefaults({
      appServer: { env: { ANTHROPIC_AUTH_TOKEN: "secret-token" } },
    }) as { appServer: { env: Record<string, string> } };
    expect(merged.appServer.env.ANTHROPIC_AUTH_TOKEN).toBe("secret-token");
    expect(merged.appServer.env.ANTHROPIC_BASE_URL).toBe(DEFAULT_ZAI_BASE_URL);
  });

  it("preserves unrelated top-level operator config", () => {
    const merged = applyGlmDefaults({ dynamicTools: { exclude: ["image"] } }) as {
      dynamicTools?: { exclude?: string[] };
      appServer: { modelProvider: string };
    };
    expect(merged.dynamicTools?.exclude).toEqual(["image"]);
    expect(merged.appServer.modelProvider).toBe("zai");
  });
});

describe("resolveClaudeAppServerConfig on GLM defaults", () => {
  it("resolves modelProvider to 'zai' so the pool key is distinct from Claude", () => {
    const resolved = resolveClaudeAppServerConfig(applyGlmDefaults(undefined));
    expect(resolved.appServer.modelProvider).toBe("zai");
  });
});

describe("claudeAppServerPoolKey", () => {
  it("gives GLM and Claude distinct pool keys (concurrency invariant)", () => {
    const glmKey = claudeAppServerPoolKey("zai");
    const claudeKey = claudeAppServerPoolKey(DEFAULT_CLAUDE_APP_SERVER_MODEL_PROVIDER);
    expect(glmKey).toBe("claude-bridge:zai");
    expect(claudeKey).toBe("claude-bridge:anthropic");
    expect(glmKey).not.toBe(claudeKey);
  });

  it("defaults to the Claude provider when no provider is supplied", () => {
    expect(claudeAppServerPoolKey()).toBe("claude-bridge:anthropic");
    expect(claudeAppServerPoolKey("")).toBe("claude-bridge:anthropic");
  });
});

describe("GLM harness supports()", () => {
  const harness = createClaudeAppServerAgentHarness({
    id: "glm-bridge",
    label: "GLM app-server harness (via Z.ai)",
    providerIds: ["zai"],
  });

  it("supports the 'zai' provider", () => {
    expect(harness.supports(supportCtx("zai"))).toMatchObject({ supported: true });
  });

  it("does not support the 'anthropic' provider (that is the Claude extension's)", () => {
    expect(harness.supports(supportCtx("anthropic"))).toMatchObject({ supported: false });
  });
});

// GLM-bridge maintains its OWN copy of the appServer/dynamicTools config
// schema (its manifest is a separate file from extensions/claude's, even
// though both resolve through the shared resolveClaudeAppServerConfig) — a
// new key added to CLAUDE_APP_SERVER_CONFIG_KEYS without a matching manifest
// update here passes typecheck and every claude-side test, then fails at
// gateway startup with "must not have additional properties" the moment an
// operator actually sets it for glm-bridge (found the hard way rolling out
// appServer.queryThreadTimeoutMs). This is the regression guard.
describe("GLM manifest config alignment", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    configSchema: ManifestConfigObject;
  };

  it("keeps appServer parser keys aligned with the manifest schema", () => {
    const appServerSchema = manifest.configSchema.properties?.appServer;
    expect(Object.keys(appServerSchema?.properties ?? {}).toSorted()).toEqual(
      [...CLAUDE_APP_SERVER_CONFIG_KEYS].toSorted(),
    );
  });

  it("keeps dynamicTools parser keys aligned with the manifest schema", () => {
    const dynamicToolsSchema = manifest.configSchema.properties?.dynamicTools;
    expect(Object.keys(dynamicToolsSchema?.properties ?? {}).toSorted()).toEqual(
      [...CLAUDE_DYNAMIC_TOOLS_CONFIG_KEYS].toSorted(),
    );
  });
});
