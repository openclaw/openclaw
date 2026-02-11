/**
 * CoreMemories integration helpers.
 *
 * Note: This module is intentionally generic and does not assume it runs inside the OpenClaw
 * gateway process. Callers should pass a deterministic memoryDir when running in a daemon/service.
 */
import { type CoreMemoriesInitOptions } from "./index";
export interface SmartReminder {
    text: string;
    scheduledTime: string;
    keywords: string[];
    context: string[] | null;
    createdAt: string;
}
export interface SmartReminderParams {
    text: string;
    scheduledTime: string;
    keywords?: string[];
}
export interface TaskEntry {
    id: string;
    type: string;
    content: string;
    keywords: string[];
    relatedMemories: Array<{
        keyword: string;
        flash: number;
        warm: number;
    }>;
    createdAt: string;
}
export interface MaintenanceResult {
    compressed: boolean;
    pendingMemoryMdUpdates: number;
    totalTokens: number;
}
export declare function heartbeatMaintenance(opts?: CoreMemoriesInitOptions): Promise<MaintenanceResult>;
export declare function createSmartReminder(params: SmartReminderParams, opts?: CoreMemoriesInitOptions): Promise<SmartReminder>;
export declare function executeSmartReminder(reminder: SmartReminder): Promise<string>;
export declare function storeTaskWithContext(task: string, opts?: CoreMemoriesInitOptions): Promise<TaskEntry>;
//# sourceMappingURL=integration.d.ts.map