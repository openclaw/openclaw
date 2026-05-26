import type { TaskRecord } from "./task-registry.types.js";
export declare const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
export declare const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
export declare const CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX = "codex-thread:";
export declare const CODEX_NATIVE_SUBAGENT_STALE_ERROR = "Codex native subagent stopped reporting progress";
export declare function isChildlessCodexNativeSubagentTask(task: TaskRecord): boolean;
