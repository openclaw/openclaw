import "../test-utils/prepare-compiled-subprocesses.js";
import { registerGatewayThreadDatabaseProbeTests } from "../../test/helpers/gateway-thread-database-probe.js";
import { agentDeletionRecoveryHoldPostgresRuntimeEntrypoint } from "../state/openclaw-state-lease-runtime.test-support.js";

registerGatewayThreadDatabaseProbeTests({
  suiteName: "agent deletion recovery hold check",
  testName:
    "reads %s holds on the Gateway thread before a persistent apply without admitting unrelated SQL",
  dirPrefix: "agent-recovery-hold-",
  entrypoint: agentDeletionRecoveryHoldPostgresRuntimeEntrypoint,
  connectionEnv: "OPENCLAW_TEST_RECOVERY_HOLD_PG_CONNECTION",
  failureReason: "Recovery hold process failed",
  successPrefix: "agent deletion recovery hold check passed on the Gateway thread: ",
});
