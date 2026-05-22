import type { RequestQuery } from "./rest-scheduler.js";
import type { RequestClient, RequestData } from "./rest.js";
export declare function createInteractionCallback(rest: RequestClient, interactionId: string, token: string, body: unknown): Promise<unknown>;
export declare function editWebhookMessage(rest: RequestClient, applicationId: string, token: string, messageId: string, data: RequestData, query?: RequestQuery): Promise<unknown>;
export declare function deleteWebhookMessage(rest: RequestClient, applicationId: string, token: string, messageId: string): Promise<unknown>;
export declare function getWebhookMessage(rest: RequestClient, applicationId: string, token: string, messageId: string): Promise<unknown>;
export declare function createWebhookMessage(rest: RequestClient, applicationId: string, token: string, data: RequestData, query?: RequestQuery): Promise<unknown>;
