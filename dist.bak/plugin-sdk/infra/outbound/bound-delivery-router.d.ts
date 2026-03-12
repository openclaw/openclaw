import { type ConversationRef, type SessionBindingRecord, type SessionBindingService } from "./session-binding-service.js";
export type BoundDeliveryRouterInput = {
    eventKind: "task_completion";
    targetSessionKey: string;
    requester?: ConversationRef;
    failClosed: boolean;
};
export type BoundDeliveryRouterResult = {
    binding: SessionBindingRecord | null;
    mode: "bound" | "fallback";
    reason: string;
};
export type BoundDeliveryRouter = {
    resolveDestination: (input: BoundDeliveryRouterInput) => BoundDeliveryRouterResult;
};
export declare function createBoundDeliveryRouter(service?: SessionBindingService): BoundDeliveryRouter;
