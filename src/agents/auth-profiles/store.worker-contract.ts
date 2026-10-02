import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { authProfileOperations } from "./store.worker.js";

export type AuthProfileWorkerOperations = WorkerOperations<typeof authProfileOperations>;
