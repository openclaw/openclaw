import path from "node:path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import {
  cleanupDynamicToolBuildFixture,
  createParams,
  setupDynamicToolBuildFixture,
} from "./dynamic-tool-build.test-support.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";

it.each([
  {
    carrier: "bootstrapped worker",
    workerAppProfileId: "synthetic-app",
    toolsAllow: undefined,
    enabled: true,
  },
  {
    carrier: "ordinary paired node",
    workerAppProfileId: undefined,
    toolsAllow: undefined,
    enabled: false,
  },
  {
    carrier: "restricted worker",
    workerAppProfileId: "synthetic-app",
    toolsAllow: ["message"],
    enabled: false,
  },
])(
  "keeps selected GitHub identity on its owning tool surface: $carrier",
  async ({ workerAppProfileId, toolsAllow, enabled }) => {
    const dir = await setupDynamicToolBuildFixture();
    onTestFinished(() => cleanupDynamicToolBuildFixture(dir, []));
    const params = createParams(path.join(dir, "session.jsonl"), dir, { toolsAllow });
    params.hostCapabilities = createCodexTestHostCapabilities({
      preparedEnvironment: () => ({
        credentialScrubEnv: {},
        localIdentityEnv: {},
        managedLocalIdentity: true,
        hostExecutionRequired: true,
      }),
    });
    const sandbox = {
      ...createSandboxTestContext(),
      backendId: "node",
      placementExecutionMode: "remote-exec",
      placementNodeId: "synthetic-node",
    };
    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, sandbox, {
        sandboxExecServerEnabled: true,
        workerAppProfileId,
        nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params, { sandbox }),
      }),
    ).toBe(enabled);
  },
);
