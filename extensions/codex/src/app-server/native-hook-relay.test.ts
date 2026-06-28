// Codex tests cover native hook relay plugin behavior.
import type { NativeHookRelayRegistrationHandle } from "openclaw/plugin-sdk/agent-harness-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import {
  acquireCodexNativeHookRelayAdmission,
  attachCodexNativeHookRelayAdmissionRelease,
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayDisabledConfig,
  resetCodexNativeHookRelayAdmissionsForTests,
  resolveCodexNativeHookRelayCommandTimeoutMs,
  resolveCodexNativeHookRelayUnregisterGraceMs,
} from "./native-hook-relay.js";

describe("Codex native hook relay config", () => {
  it("builds deterministic Codex config overrides with command hooks", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      hookTimeoutSec: 7,
    });

    expect(config).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event post_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event before_agent_finalize --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("timeoutSec");
    expect(JSON.stringify(config)).not.toContain('"matcher":null');
    expect(config).not.toHaveProperty("hooks.SessionStart");
    expect(config).not.toHaveProperty("hooks.UserPromptSubmit");
  });

  it("includes only requested hook events", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 4000",
              timeout: 5,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears requested hook events when the relay reports no local work", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ inactiveEvents: ["post_tool_use", "before_agent_finalize"] }),
        events: ["pre_tool_use", "post_tool_use", "before_agent_finalize"],
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 4000",
              timeout: 5,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [],
      "hooks.Stop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("keeps selected no-policy PreToolUse installed with an unavailable no-op marker", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ inactiveEvents: ["pre_tool_use"] }),
        events: ["pre_tool_use"],
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --pre-tool-use-unavailable noop --timeout 4000",
              timeout: 5,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears omitted hook events when requested", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
        clearOmittedEvents: true,
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 4000",
              timeout: 5,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": { enabled: false },
        "<session-flags>/config.toml:stop:0:0": { enabled: false },
      },
    });
  });

  it("reserves relay timeout margin before Codex can kill the hook subprocess", () => {
    expect(resolveCodexNativeHookRelayCommandTimeoutMs(undefined)).toBe(4000);
    expect(resolveCodexNativeHookRelayCommandTimeoutMs(1)).toBe(750);
    expect(resolveCodexNativeHookRelayCommandTimeoutMs(7)).toBe(6000);
  });

  it("omits matchers so Codex MCP tool names reach the relay with a stable trust hash", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      events: ["pre_tool_use", "post_tool_use"],
    });

    expect((config["hooks.PreToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
    expect((config["hooks.PostToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
  });

  it("builds deterministic clearing config when the relay is disabled", () => {
    expect(buildCodexNativeHookRelayDisabledConfig()).toEqual({
      "features.hooks": false,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
    });
  });

  it("caps oversized native hook cleanup grace before scheduling", () => {
    expect(resolveCodexNativeHookRelayUnregisterGraceMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("denies relay admission when available memory is below the configured floor", () => {
    const admission = acquireCodexNativeHookRelayAdmission({
      enabled: true,
      minAvailableMemoryMb: 1024,
      getAvailableMemoryBytesForTests: () => 512 * 1024 * 1024,
      memoryUsageForTests: () => ({ rss: 128 * 1024 * 1024 }),
    });

    expect(admission).toMatchObject({
      allowed: false,
      reason: "available_memory",
      availableMemoryBytes: 512 * 1024 * 1024,
      thresholdBytes: 1024 * 1024 * 1024,
    });
  });

  it("denies relay admission when process rss exceeds the configured ceiling", () => {
    const admission = acquireCodexNativeHookRelayAdmission({
      enabled: true,
      maxProcessRssMb: 512,
      getAvailableMemoryBytesForTests: () => 4096 * 1024 * 1024,
      memoryUsageForTests: () => ({ rss: 768 * 1024 * 1024 }),
    });

    expect(admission).toMatchObject({
      allowed: false,
      reason: "process_rss",
      processRssBytes: 768 * 1024 * 1024,
      thresholdBytes: 512 * 1024 * 1024,
    });
  });

  it("caps concurrent admitted native hook relays", () => {
    resetCodexNativeHookRelayAdmissionsForTests();
    const config = {
      enabled: true,
      maxActiveRelays: 1,
      getAvailableMemoryBytesForTests: () => 4096 * 1024 * 1024,
      memoryUsageForTests: () => ({ rss: 128 * 1024 * 1024 }),
    };
    const first = acquireCodexNativeHookRelayAdmission(config);
    const second = acquireCodexNativeHookRelayAdmission(config);

    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({
      allowed: false,
      reason: "max_active_relays",
      activeRelays: 1,
      thresholdRelays: 1,
    });
    if (first.allowed) {
      first.release?.();
    }
    const afterRelease = acquireCodexNativeHookRelayAdmission(config);
    expect(afterRelease.allowed).toBe(true);
    if (afterRelease.allowed) {
      afterRelease.release?.();
    }
  });

  it("releases an admission cap when the wrapped relay unregisters", () => {
    resetCodexNativeHookRelayAdmissionsForTests();
    const config = {
      enabled: true,
      maxActiveRelays: 1,
      getAvailableMemoryBytesForTests: () => 4096 * 1024 * 1024,
      memoryUsageForTests: () => ({ rss: 128 * 1024 * 1024 }),
    };
    const admission = acquireCodexNativeHookRelayAdmission(config);
    if (!admission.allowed) {
      throw new Error("Expected relay admission");
    }
    const relay = attachCodexNativeHookRelayAdmissionRelease(createRelay(), admission.release);

    relay.unregister();

    const afterRelease = acquireCodexNativeHookRelayAdmission(config);
    expect(afterRelease.allowed).toBe(true);
    if (afterRelease.allowed) {
      afterRelease.release?.();
    }
  });
});

function createRelay(options?: {
  inactiveEvents?: readonly NativeHookRelayRegistrationHandle["allowedEvents"][number][];
}): NativeHookRelayRegistrationHandle {
  const inactiveEvents = new Set(options?.inactiveEvents ?? []);
  return {
    relayId: "relay-1",
    provider: "codex",
    generation: "generation-1",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    allowedEvents: ["pre_tool_use", "post_tool_use", "permission_request", "before_agent_finalize"],
    expiresAtMs: Date.now() + 1000,
    shouldRelayEvent: (event) => !inactiveEvents.has(event),
    commandForEvent: (event, commandOptions) =>
      `openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event ${event}${
        event === "pre_tool_use" && inactiveEvents.has(event)
          ? " --pre-tool-use-unavailable noop"
          : ""
      }${commandOptions?.timeoutMs ? ` --timeout ${commandOptions.timeoutMs}` : ""}`,
    renew: () => undefined,
    unregister: () => undefined,
  };
}
