// Codex native hook relay startup attestation and relay-shape guard regressions.
import path from "node:path";
import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  createParams,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  createLoopRelayParams,
  setupNativeHookRelayTestHooks,
} from "./run-attempt.native-hook-relay.test-helpers.js";

setupNativeHookRelayTestHooks();

describe("runCodexAppServerAttempt native hook relay attestation", () => {
  it("refuses to run when managed-only hooks would silently discard its enforcing relay", async () => {
    const sessionFile = path.join(tempDir, "managed-hooks-only.jsonl");
    const workspaceDir = path.join(tempDir, "managed-hooks-only-workspace");
    const harness = createStartedThreadHarness(async (method) =>
      method === "configRequirements/read"
        ? { requirements: { allowManagedHooksOnly: true } }
        : undefined,
    );

    await expect(
      runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
      }),
    ).rejects.toThrow(/managed-only hooks.*OpenClaw native hook relay/i);
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("still attests managed hook policy when a before-tool policy narrows the relay opt-out", async () => {
    // A configured `nativeHookRelay.enabled: false` cannot reach the app-server
    // unchanged while a before-tool policy is live: the guard narrows it back to
    // the enforcing `pre_tool_use` relay. Attestation is gated on that guarded
    // shape, not the raw operator config, so a managed-only install must still be
    // refused rather than silently discarding the relay OpenClaw is relying on.
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "managed-hooks-only-opt-out.jsonl");
    const workspaceDir = path.join(tempDir, "managed-hooks-only-opt-out-workspace");
    const harness = createStartedThreadHarness(async (method) =>
      method === "configRequirements/read"
        ? { requirements: { allowManagedHooksOnly: true } }
        : undefined,
    );

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        nativeHookRelay: { enabled: false },
      }),
    ).rejects.toThrow(/managed-only hooks.*OpenClaw native hook relay/i);
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("does not attest managed hook policy when an honored relay opt-out leaves nothing to enforce", async () => {
    // The negative of the test above, on the same managed-only app-server:
    // approvals off and no before-tool policy, so the opt-out survives the guard
    // and there is no enforcing relay for managed-only policy to discard. The
    // attestation gate is read through its refusal rather than through the bare
    // presence of `configRequirements/read`, which the tool-policy preflight also
    // issues on every attempt for its own reasons.
    const sessionFile = path.join(tempDir, "managed-hooks-only-honored-opt-out.jsonl");
    const workspaceDir = path.join(tempDir, "managed-hooks-only-honored-opt-out-workspace");
    const harness = createStartedThreadHarness(async (method) =>
      method === "configRequirements/read"
        ? { requirements: { allowManagedHooksOnly: true } }
        : undefined,
    );

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: { appServer: { mode: "yolo", approvalPolicy: "never" } },
      nativeHookRelay: { enabled: false },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    // The premise: the opt-out was honored verbatim, not narrowed back to the
    // enforcing `pre_tool_use` relay.
    const startConfig = (
      harness.requests.find((request) => request.method === "thread/start")?.params as
        | { config?: Record<string, unknown> }
        | undefined
    )?.config;
    expect(startConfig?.["hooks.PreToolUse"]).toEqual([]);
    expect(startConfig?.["hooks.PostToolUse"]).toEqual([]);
  });

  it("allows observational hooks under managed-only hook policy", async () => {
    const sessionFile = path.join(tempDir, "observational-hooks-only.jsonl");
    const workspaceDir = path.join(tempDir, "observational-hooks-only-workspace");
    const harness = createStartedThreadHarness(async (method) =>
      method === "configRequirements/read"
        ? { requirements: { allowManagedHooksOnly: true } }
        : undefined,
    );

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true, events: ["post_tool_use"] },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    expect(startRequest?.params).not.toHaveProperty(["config", "hooks.PreToolUse"]);
  });

  it("rejects Guardian review when the running server resolves an untrusted managed endpoint", async () => {
    const sessionFile = path.join(tempDir, "managed-review-endpoint.jsonl");
    const workspaceDir = path.join(tempDir, "managed-review-endpoint-workspace");
    const params = createParams(sessionFile, workspaceDir, { provider: "openai" });
    const harness = createStartedThreadHarness(async (method) =>
      method === "config/read"
        ? { config: { openai_base_url: "https://review-proxy.example.invalid/v1" }, origins: {} }
        : undefined,
    );

    await expect(
      runCodexAppServerAttempt(params, {
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).rejects.toThrow(/model-backed approval reviewer.*trusted OpenAI/i);
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("retains the pre_tool_use relay when a before-tool policy is active under explicit yolo", async () => {
    // Explicit `approvalPolicy: "never"` plus a live before_tool_call hook. If the
    // opt-out emitted `features.hooks: false` here, the relay that executes and can
    // block that policy would never run for this attempt.
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "policy-yolo.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-policy-yolo");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: { appServer: { mode: "yolo", approvalPolicy: "never" } },
      nativeHookRelay: { enabled: false },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startParams = startRequest?.params as
      | { approvalPolicy?: unknown; config?: Record<string, unknown> }
      | undefined;
    expect(startParams?.approvalPolicy).toBe("never");
    expect(startParams?.config?.["features.hooks"]).toBe(true);
    const preToolUse = startParams?.config?.["hooks.PreToolUse"];
    expect(Array.isArray(preToolUse) && preToolUse.length > 0).toBe(true);
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.allowedEvents,
    ).toEqual(["pre_tool_use"]);
    await nativeHookRelayUnregisterQueue.flush();
  });
});
