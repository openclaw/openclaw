import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { GatewayOperatorAccessUnavailableError } from "../../../gateway/operator-access-policy.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { operatorFixture } from "./subagent-registry.completed-followup-authority.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";

export function registerCompletionCompatibilityTests(
  registration: (runId: string) => Parameters<typeof registerSubagentRun>[0],
) {
  it("uses the baseline for distinct live invocations of the same source", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      config.setRuntimeConfigSnapshot({});
      vi.mocked(config.getRuntimeConfig).mockReturnValue({});
      const fixture = operatorFixture("invocation-owner");
      const sources = [];
      try {
        for (const runId of ["invocation-one", "invocation-two"]) {
          const source = expectDefined(
            await operatorCapture.captureGatewayOperatorRunAuthority({
              ...fixture,
              invocationAuthority: { assertCurrent: () => {} },
            }),
            "invocation source",
          );
          sources.push(source);
          const client = {
            ...fixture.client,
            internal: { ...fixture.client.internal, operatorRunAuthority: source.authority },
          };
          await withPluginRuntimeGatewayRequestScope(
            { ...fixture, client, isWebchatConnect: () => false },
            () => registerSubagentRun(registration(runId)),
          );
        }
        expect(sources[0]?.authority.source).not.toBe(sources[1]?.authority.source);
        const batch = ["invocation-one", "invocation-two"].map((runId) =>
          expectDefined(subagentRuns.get(runId), "child"),
        );
        subagentRuns.runWithCompletionBatchAuthority(batch, () => {
          expect(
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
          ).toBeUndefined();
          const client = getPluginRuntimeGatewayRequestScope()?.client;
          expect(client?.connect.scopes).toEqual(["operator.write"]);
          expect(client?.authenticatedUserProfile).toBeUndefined();
          expect(client?.internal?.agentRuntimeIdentity).toBeUndefined();
        });
      } finally {
        for (const source of sources) {
          source.release();
        }
      }
    });
  });

  it("retries temporary access unavailability without losing live completion custody", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      config.setRuntimeConfigSnapshot({});
      vi.mocked(config.getRuntimeConfig).mockReturnValue({});
      const fixture = operatorFixture("retry-owner");
      let unavailable = false;
      fixture.sourceAuthority.assertCurrent = () => {
        if (unavailable) {
          throw new GatewayOperatorAccessUnavailableError();
        }
        fixture.revoked.signal.throwIfAborted();
      };
      const source = expectDefined(
        await operatorCapture.captureGatewayOperatorRunAuthority(fixture),
        "source",
      );
      fixture.client.internal = { operatorRunAuthority: source.authority };
      try {
        await withPluginRuntimeGatewayRequestScope(
          { ...fixture, isWebchatConnect: () => false },
          () => registerSubagentRun(registration("retry-child")),
        );
        source.release();
        const entry = expectDefined(subagentRuns.get("retry-child"), "child");
        const delivery = vi.fn(
          () =>
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.source,
        );
        unavailable = true;
        expect(() => subagentRuns.runWithCompletionBatchAuthority([entry], delivery)).toThrow(
          GatewayOperatorAccessUnavailableError,
        );
        expect(delivery).not.toHaveBeenCalled();
        expect(source.authority.signal?.aborted).not.toBe(true);
        unavailable = false;
        expect(subagentRuns.runWithCompletionBatchAuthority([entry], delivery)).toBe(
          source.authority.source,
        );
        expect(delivery).toHaveBeenCalledOnce();
      } finally {
        source.release();
      }
    });
  });
}
