import { CoreMemories } from "./index";
export interface SessionContinuationIntegration {
    enabled: boolean;
    lastSessionFile: string;
}
export declare function initSessionContinuation(coreMemories: CoreMemories, userId?: string): Promise<string | undefined>;
export declare function heartbeatSessionCheck(coreMemories: CoreMemories): Promise<void>;
export declare function getSmartReminderContext(coreMemories: CoreMemories, reminderTopic: string): Promise<string>;
export declare function onSessionStart(coreMemories: CoreMemories, sendMessage: (msg: string) => void | Promise<void>): Promise<void>;
//# sourceMappingURL=session-continuation-integration.d.ts.map