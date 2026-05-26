import type { TaskFlowDetail, TaskFlowView, TaskRunAggregateSummary, TaskRunDetail, TaskRunView } from "../plugins/runtime/task-domain-types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";
export declare function mapTaskRunAggregateSummary(summary: TaskRegistrySummary): TaskRunAggregateSummary;
export declare function mapTaskRunView(task: TaskRecord): TaskRunView;
export declare function mapTaskRunDetail(task: TaskRecord): TaskRunDetail;
export declare function mapTaskFlowView(flow: TaskFlowRecord): TaskFlowView;
export declare function mapTaskFlowDetail(params: {
    flow: TaskFlowRecord;
    tasks: TaskRecord[];
    summary?: TaskRegistrySummary;
}): TaskFlowDetail;
