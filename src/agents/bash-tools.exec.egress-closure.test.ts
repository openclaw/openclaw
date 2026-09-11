import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../infra/agent-run-registry.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyHandle,
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
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

let state: OpenClawTestState | undefined;
let proxy: SecretEgressProxyHandle | undefined;
let unsubscribe: (() => void) | undefined;
const admissions: PreparedAgentRunAdmission[] = [];

afterEach(async () => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  unsubscribe?.();
  unsubscribe = undefined;
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
  const ownedProxy = proxy;
  // Use the Gateway's full-run closure event; approval-generation closure is separate.
  unsubscribe = registerAgentRunDelegatedAuthorityClosedHandler((authority, reason) => {
    if (!reason) {
      ownedProxy.revokeRun(authority.operationalRunInstance);
    }
  });
});

describe("exec proxy registration after store preparation", () => {
  it.each(["close", "abort"] as const)(
    "mints no proxy credentials after %s and leaves the next invocation usable",
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
      const registrations = vi.spyOn(proxy, "registerRun");
      const revocations = vi.spyOn(proxy, "revokeRun");
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
        const sessionKey = "agent:probe:cron:egress-closure:trigger";
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "probe",
          sessionKey,
          approvalSignals: [controller.signal],
        });
        if (!caller) {
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
        return {
          admission,
          admitted,
          controller,
          execute: () =>
            withGatewayToolCallerIdentity(caller, () =>
              tool.execute(
                `exec-${runId}`,
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
      // Drain the implementation itself: an abort wrapper can settle while exec continues.
      const retiredExecution = retired.execute().then(
        (value) => ({ status: "completed" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      void retiredExecution.then((outcome) => {
        enteredStoreRead.reject(
          outcome.status === "rejected"
            ? outcome.error
            : new Error("Exec completed before the store-read boundary"),
        );
      });
      await enteredStoreRead.promise;
      if (revocation === "abort") {
        retired.controller.abort();
      }
      // Cancellation's cron owner closes admission before a detached exec can resume.
      retired.admission.close();
      const retiredOutcome = await retiredExecution;
      const lateRegistrationCount = registrations.mock.calls.length;
      const retiredSpawnCount = spawns.mock.calls.length;
      storeRead.mockRestore();

      const later = await createInvocation(`egress-${revocation}-later`);
      const laterResult = await later.execute();
      later.admission.close();

      expect(retiredOutcome.status).toBe("rejected");
      expect(retired.controller.signal.aborted).toBe(revocation === "abort");
      expect(retiredSpawnCount).toBe(0);
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
      expect(revocations.mock.calls.map(([run]) => run)).toEqual([
        retired.admitted.operationalRunInstance,
        later.admitted.operationalRunInstance,
      ]);
      expect(lateRegistrationCount).toBe(0);
      expect(registrations.mock.calls.map(([run]) => run)).toEqual([
        later.admitted.operationalRunInstance,
      ]);
    },
  );
});
