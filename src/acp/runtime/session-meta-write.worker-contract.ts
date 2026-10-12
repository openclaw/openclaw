import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { acpSessionOperations } from "./session-meta-write.worker.js";

export type AcpSessionWriteOperations = WorkerOperations<typeof acpSessionOperations>;
