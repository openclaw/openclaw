import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { withinTest } from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTestOperatorAuthority } from "./admitted-run-context.test-support.js";
import { createOpenClawCodingToolsInternalAsync } from "./agent-tools.async.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import {
  admitModelTurn,
  completionConfig,
  fullGatewayExec,
  nodeCommand,
  runningSession,
} from "./bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "./embedded-agent.js";
import { createBaseOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

// mock-isolation: Keep inference outside the real Linux process and session admission path.
vi.mock("./embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

let state: OpenClawTestState;
let config: OpenClawConfig;
const receipts: sessionEvents.SessionEventReceipt[] = [];
const enqueue = sessionEvents.enqueueSessionEventForHost;

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "exec-wake-owner",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  config = completionConfig(state.workspaceDir);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
});

beforeEach(() => {
  setRuntimeConfigSnapshot(config);
  model.mockReset();
  vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation((text, options) => {
    const receipt = enqueue(text, options);
    receipts.push(receipt);
    return receipt;
  });
});

afterEach(async () => {
  for (const receipt of receipts) {
    receipt.cancel();
  }
  await Promise.all(receipts.map((receipt) => receipt.settled));
  receipts.length = 0;
  vi.restoreAllMocks();
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

afterAll(() => state?.cleanup());

test.for([
  {
    label: "owner",
    admin: true,
    tainted: false,
    crossSession: false,
    owner: true,
    origin: "agent",
  },
  {
    label: "guest",
    admin: false,
    tainted: false,
    crossSession: false,
    owner: false,
    origin: "untrusted",
  },
  {
    label: "tainted-owner",
    admin: true,
    tainted: true,
    crossSession: false,
    owner: true,
    origin: "untrusted",
  },
  // The requester's admitted grant decides the wake, also when the command ran for another chat.
  {
    label: "cross-session",
    admin: true,
    tainted: false,
    crossSession: true,
    owner: true,
    origin: "agent",
  },
] as const)(
  "classifies a tracked memory write after an exec wake: $label",
  async (testCase, { signal }) => {
    const sessionKey = `agent:main:dashboard:memory-${testCase.label}`;
    const callerSessionKey = testCase.crossSession
      ? "agent:main:dashboard:other-session"
      : sessionKey;
    const workspaceDir = await fs.mkdtemp(path.join(state.workspaceDir, "exec-wake-memory-"));
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      {
        sessionId: sessionKey.replaceAll(":", "-"),
        lifecycleRevision: "original",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        permissionMode: "full",
      },
    );
    const operatorAuthority = createTestOperatorAuthority({
      profileId: testCase.admin ? GATEWAY_OWNER_PROFILE_ID : "exec-wake-guest",
      scopes: testCase.admin ? ["operator.admin"] : ["operator.write"],
    });
    // Stop at model inference, but execute the real tracked file tool with the admitted owner bit.
    model.mockImplementation(async (params) => {
      await admitModelTurn(params);
      const tools = await createOpenClawCodingToolsInternalAsync({
        config: params.config,
        agentId: "main",
        sessionKey: params.sessionKey,
        workspaceDir,
        senderIsOwner: params.senderIsOwner,
        isTurnTainted: () => testCase.tainted,
        toolConstructionPlan: createBaseOnlyToolConstructionPlan(),
        wrapBeforeToolCallHook: false,
      });
      await expectDefined(
        tools.find((tool) => tool.name === "write"),
        "tracked write tool",
      ).execute("exec-wake-write", { path: "MEMORY.md", content: "Exec completion note.\n" });
      return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
    });

    const exec = createExecTool({
      config,
      ...fullGatewayExec,
      agentId: "main",
      sessionKey,
      scopeKey: sessionKey,
      notifyOnExit: true,
      allowBackground: true,
    });
    const started = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: callerSessionKey, operatorAuthority },
      () =>
        exec.execute("exec-wake-memory", {
          command: nodeCommand('process.stdout.write("EXEC_WAKE_MEMORY_DONE")'),
          background: true,
        }),
    );
    runningSession(started.details);
    await withinTest(waitForExecScope(sessionKey), signal);
    const receipt = expectDefined(receipts.at(-1), "completion receipt");
    expect(await withinTest(receipt.accepted, signal)).toEqual({ ok: true });
    const outcome = await withinTest(receipt.settled, signal);
    expect(outcome, outcome.error).toMatchObject({ status: "completed", executionStarted: true });
    const [params] = expectDefined(model.mock.calls[0], "completion turn");
    expect(params.prompt).toContain("EXEC_WAKE_MEMORY_DONE");
    await expect(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).resolves.toBe(
      "Exec completion note.\n",
    );
    expect({
      owner: params.senderIsOwner,
      origin: (await readMemoryArtifactProvenance({ workspaceDir, relativePath: "MEMORY.md" }))
        ?.originClass,
    }).toEqual({ owner: testCase.owner, origin: testCase.origin });
  },
);
