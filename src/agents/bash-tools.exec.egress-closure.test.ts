import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyHandle,
  type SecretEgressProcessGrant,
} from "../secrets/egress-proxy/proxy-server.js";
import {
  clearSecretEgressProxy,
  publishSecretEgressProxy,
} from "../secrets/egress-proxy/registry.js";
import * as secretStore from "../secrets/store/secret-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { bindAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

let state: OpenClawTestState | undefined;
let proxy: SecretEgressProxyHandle | undefined;
const admissions: PreparedAgentRunAdmission[] = [];

afterEach(async () => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  vi.restoreAllMocks();
  try {
    if (proxy) {
      clearSecretEgressProxy(proxy);
      await proxy.stop();
      proxy = undefined;
    }
  } finally {
    await state?.cleanup();
    state = undefined;
  }
});

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-exec-egress-closure-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  proxy = await startSecretEgressProxyServer({
    caDir: state.path("proxy-ca"),
    allowedHosts: [],
    onAudit: () => {},
  });
  publishSecretEgressProxy(proxy);
});

it.each(["close", "abort"] as const)(
  "isolates process credentials and later invocations after %s during preparation",
  async (revocation) => {
    if (!state || !proxy) {
      throw new Error("Expected the isolated exec fixture");
    }
    const config: OpenClawConfig = {
      agents: {
        defaults: { workspace: state.workspaceDir, skipBootstrap: true },
        entries: { probe: { workspace: state.workspaceDir } },
      },
      plugins: { enabled: false },
      tools: { exec: { host: "gateway", security: "full", ask: "off" } },
      secrets: { egressProxy: { enabled: true } },
    };
    await state.writeConfig(config);
    const workspaceDir = state.workspaceDir;
    const grants: SecretEgressProcessGrant[] = [];
    const registerProcess = proxy.registerProcess;
    const registrations = vi.spyOn(proxy, "registerProcess").mockImplementation((...args) => {
      const grant = registerProcess(...args);
      vi.spyOn(grant, "revoke");
      grants.push(grant);
      return grant;
    });
    const spawns = vi.spyOn(getProcessSupervisor(), "spawn");

    const createInvocation = async (runId: string) => {
      const controller = new AbortController();
      const admission = prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: "probe",
          ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
        },
      });
      admissions.push(admission);
      const admitted = await admission.admit("gateway");
      const assertActive = resolveAdmittedRunActiveAssertion(admitted, controller.signal);
      const sessionKey = "agent:probe:cron:egress-closure:trigger";
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "probe",
        sessionKey,
        approvalSignals: [controller.signal],
      });
      if (!caller || !assertActive) {
        throw new Error("Expected the admitted exec caller");
      }
      const tool = createExecTool({
        config,
        agentId: "probe",
        sessionKey,
        runId,
        operationalRunInstance: admitted.operationalRunInstance,
        trigger: "cron",
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: workspaceDir,
        allowBackground: false,
        notifyOnExit: false,
      });
      const retainedTool = wrapToolWithBeforeToolCallHook(
        bindAgentToolSourceExecutionGuard(tool, assertActive),
      );
      return {
        admission,
        admitted,
        controller,
        execute: (toolCallId = `exec-${runId}`) =>
          withGatewayToolCallerIdentity(caller, () =>
            retainedTool.execute(
              toolCallId,
              { command: "printf cron-egress-ok" },
              controller.signal,
            ),
          ),
      };
    };

    const retired = await createInvocation(`egress-${revocation}-retired`);
    const enteredStoreRead = createDeferred();
    const readStore = secretStore.readSecretStoreExecEnvironment;
    const storeRead = vi
      .spyOn(secretStore, "readSecretStoreExecEnvironment")
      .mockImplementationOnce((params) => {
        // The waiting test resumes before exec's import/read promise continuation.
        enteredStoreRead.resolve();
        return readStore(params);
      });
    // Drain the implementation itself: cancellation can settle an outer wrapper first.
    const retiredExecution = retired.execute().then(
      (result) => ({ result, rejected: false }),
      () => ({ result: undefined, rejected: true }),
    );
    await awaitGateBeforeSettlement(
      enteredStoreRead.promise,
      retiredExecution,
      "Exec completed before the store-read boundary",
    );
    if (revocation === "abort") {
      retired.controller.abort();
    }
    // Closing admission rejects the next call; only abort cancels admitted work.
    retired.admission.close();
    const { result: retiredResult, rejected } = await retiredExecution;
    const lateRegistrationCount = registrations.mock.calls.length;
    const retiredSpawnCount = spawns.mock.calls.length;
    storeRead.mockRestore();
    await expect(retired.execute(`retained-exec-${revocation}`)).rejects.toThrow();
    expect(registrations).toHaveBeenCalledTimes(lateRegistrationCount);
    expect(spawns).toHaveBeenCalledTimes(retiredSpawnCount);

    const later = await createInvocation(`egress-${revocation}-later`);
    const laterResult = await later.execute();
    later.admission.close();

    expect(rejected).toBe(revocation === "abort");
    expect(retired.controller.signal.aborted).toBe(revocation === "abort");
    expect(retiredSpawnCount).toBe(revocation === "abort" ? 0 : 1);
    if (revocation === "close") {
      expect(retiredResult?.details).toMatchObject({
        status: "completed",
        exitCode: 0,
        aggregated: "cron-egress-ok",
      });
    }
    expect(getAdmittedRunDelegatedAuthority(retired.admitted)).toBeUndefined();
    expect(laterResult.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "cron-egress-ok",
    });
    expect(getAdmittedRunDelegatedAuthority(later.admitted)).toBeUndefined();
    expect(later.admitted.operationalRunInstance).not.toEqual(
      retired.admitted.operationalRunInstance,
    );
    expect(lateRegistrationCount).toBe(revocation === "abort" ? 0 : 1);
    expect(registrations).toHaveBeenCalledTimes(lateRegistrationCount + 1);
    for (const grant of grants) {
      expect(grant.revoke).toHaveBeenCalled();
    }
  },
);
