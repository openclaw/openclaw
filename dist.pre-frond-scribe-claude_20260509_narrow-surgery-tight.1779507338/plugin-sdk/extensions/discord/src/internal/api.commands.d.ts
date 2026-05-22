import { type APIApplicationCommand } from "discord-api-types/v10";
import type { RequestClient } from "./rest.js";
export declare function listApplicationCommands(rest: RequestClient, clientId: string): Promise<APIApplicationCommand[]>;
export declare function createApplicationCommand(rest: RequestClient, clientId: string, body: unknown): Promise<unknown>;
export declare function editApplicationCommand(rest: RequestClient, clientId: string, commandId: string, body: unknown): Promise<unknown>;
export declare function deleteApplicationCommand(rest: RequestClient, clientId: string, commandId: string): Promise<void>;
export declare function overwriteApplicationCommands(rest: RequestClient, clientId: string, body: unknown): Promise<void>;
export declare function overwriteGuildApplicationCommands(rest: RequestClient, clientId: string, guildId: string, body: unknown): Promise<void>;
