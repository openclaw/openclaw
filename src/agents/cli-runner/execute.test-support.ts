import { setCliRunnerExecuteTestDeps } from "./execute.js";
import { createCliRunnerExecuteTestDeps } from "./execute.test-support-core.js";

export {
  createManagedRun,
  enqueueSystemEventMock,
  requestHeartbeatMock,
  supervisorSpawnMock,
} from "./execute.test-support-core.js";

setCliRunnerExecuteTestDeps(createCliRunnerExecuteTestDeps());
