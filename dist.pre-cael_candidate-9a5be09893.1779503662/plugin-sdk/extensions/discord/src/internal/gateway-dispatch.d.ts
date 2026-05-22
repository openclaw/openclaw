import type { Client } from "./client.js";
export declare function dispatchVoiceGatewayEvent(client: Client, type: string, data: unknown): void;
export declare function mapGatewayDispatchData(client: Client, type: string, data: unknown): unknown;
