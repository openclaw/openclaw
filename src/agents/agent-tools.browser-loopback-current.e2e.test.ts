import { afterEach, expect, it, vi } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  prepareExecApprovalsCurrentRead,
  updateExecApprovals,
} from "../infra/exec-approvals-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createLocalBrowserLoopbackAssertion } from "./agent-tools.execution-policy.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createAdmittedHostCapabilityTestFixture } from "./harness/host-capability.test-support.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";
import { projectEffectiveExecPolicy } from "./session-permission-exec-mode.js";

const hostExecPolicy = projectEffectiveExecPolicy({
  base: { host: "gateway", security: "full", ask: "off" },
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("revokes an automatic preview when the execution-policy owner restricts host approvals", async () => {
  const context = captureOpenClawStateWorkerContext({
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("browser-loopback-policy-") },
  });
  const publish = (security: "full" | "deny") =>
    updateExecApprovals(
      {
        update: {
          kind: "replace",
          file: { version: 1, defaults: { security, ask: "off" } },
        },
      },
      context,
    );
  await publish("full");
  const readCurrent = await prepareExecApprovalsCurrentRead(context);
  const config = {};
  const assertPreviewCurrent = createLocalBrowserLoopbackAssertion(
    {
      options: { config },
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      effectiveExecPolicy: hostExecPolicy,
      sandboxed: false,
      workspaceOnly: false,
      execApprovals: readCurrent(),
    },
    readCurrent,
  );
  expect(assertPreviewCurrent).toBeTypeOf("function");
  expect(assertPreviewCurrent).not.toThrow();
  await publish("deny");
  expect(assertPreviewCurrent).toThrow("current unrestricted local execution");
  await publish("full");
  expect(assertPreviewCurrent).not.toThrow();
});

it("revokes the native turn grant when its inner abort signal closes", () => {
  const controller = new AbortController();
  const config = {};
  const approvals = {
    version: 1 as const,
    defaults: { security: "full" as const, ask: "off" as const },
  };
  const assertCurrent = createLocalBrowserLoopbackAssertion(
    {
      options: { config, abortSignal: controller.signal },
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      effectiveExecPolicy: hostExecPolicy,
      sandboxed: false,
      workspaceOnly: false,
      execApprovals: approvals,
    },
    () => approvals,
  );
  expect(assertCurrent).not.toThrow();
  controller.abort(new Error("native turn replaced"));
  expect(assertCurrent).toThrow("native turn replaced");
});

it("retires the grant when the runtime config owner publishes a policy change", () => {
  const config = {
    tools: { exec: { host: "gateway" as const, security: "full" as const, ask: "off" as const } },
  };
  const approvals = {
    version: 1 as const,
    defaults: { security: "full" as const, ask: "off" as const },
  };
  setRuntimeConfigSnapshot(config);
  try {
    const assertCurrent = createLocalBrowserLoopbackAssertion(
      {
        options: { config },
        capabilityProfile: resolveConversationCapabilityProfile({ config }),
        effectiveExecPolicy: hostExecPolicy,
        sandboxed: false,
        workspaceOnly: false,
        execApprovals: approvals,
      },
      () => approvals,
    );
    expect(assertCurrent).not.toThrow();
    setRuntimeConfigSnapshot({
      tools: { exec: { host: "gateway", security: "deny", ask: "off" } },
    });
    expect(assertCurrent).toThrow("policy changed");
  } finally {
    clearRuntimeConfigSnapshot();
  }
});

it("keeps Browser callable while requiring the live host's native execution declaration", async () => {
  const config = {
    tools: { gatewayPolicy: { allow: ["browser"], actions: { browser: ["snapshot"] } } },
  };
  const { hostCapabilities, closeHost, closeAdmission } =
    await createAdmittedHostCapabilityTestFixture({
      runId: "browser-native-execution",
      config,
    });
  const plugins = vi
    .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptionsAsync")
    .mockResolvedValue([]);
  try {
    for (const nativeLocalExecution of [undefined, true] as const) {
      vi.mocked(createOpenClawTools).mockClear();
      const tools = await hostCapabilities.createToolSurfaceAsync!(
        {
          config,
          sessionPermissionPolicy: { mode: "full", root: process.cwd() },
        },
        { nativeLocalExecution },
      );
      expect(tools.some((tool) => tool.name === "browser")).toBe(true);
      expect(tools.some((tool) => tool.name === "exec")).toBe(false);
      const { context } = resolveOpenClawPluginToolInputs({
        options: vi.mocked(createOpenClawTools).mock.calls.at(-1)?.[0],
      });
      expect(context.browser.allowLocalLoopback).toBe(nativeLocalExecution === true);
    }
  } finally {
    plugins.mockRestore();
    closeHost();
    closeAdmission();
  }
});
