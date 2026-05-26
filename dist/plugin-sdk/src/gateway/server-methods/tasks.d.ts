import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { type TaskSummary } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
declare function mapTaskSummary(task: TaskRecord): TaskSummary;
export declare const tasksHandlers: GatewayRequestHandlers;
export declare const testApi: {
    mapTaskSummary: typeof mapTaskSummary;
};
export { testApi as __test };
