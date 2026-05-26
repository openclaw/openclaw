import type { ErrorObject } from "ajv";
import type { RespondFn } from "./types.js";
export type Validator<T> = ((params: unknown) => params is T) & {
    errors?: ErrorObject[] | null;
};
export declare function assertValidParams<T>(params: unknown, validate: Validator<T>, method: string, respond: RespondFn): params is T;
