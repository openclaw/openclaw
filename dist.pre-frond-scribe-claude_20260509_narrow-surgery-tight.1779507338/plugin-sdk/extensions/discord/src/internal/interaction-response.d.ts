import { InteractionResponseType } from "discord-api-types/v10";
export type InteractionResponseState = "unacknowledged" | "deferred" | "deferred-update" | "replied";
type InteractionReplyAction = "initial" | "edit" | "follow-up";
export declare class InteractionResponseController {
    state: InteractionResponseState;
    get acknowledged(): boolean;
    recordCallback(type: InteractionResponseType): void;
    nextReplyAction(): InteractionReplyAction;
    recordReplyEdit(): void;
}
export declare function needsComponentsV2Query(body: unknown): boolean;
export {};
