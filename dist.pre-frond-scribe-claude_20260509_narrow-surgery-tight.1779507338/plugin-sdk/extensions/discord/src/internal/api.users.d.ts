import { type APIChannel, type APIUser } from "discord-api-types/v10";
import type { RequestClient } from "./rest.js";
export declare function getCurrentUser(rest: RequestClient): Promise<APIUser>;
export declare function getUser(rest: RequestClient, userId: string): Promise<APIUser>;
export declare function createUserDmChannel(rest: RequestClient, recipientId: string): Promise<Pick<APIChannel, "id">>;
