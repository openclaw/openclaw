import { Type } from "typebox";
export { optionalStringEnum, stringEnum } from "./string-enum.js";
export declare function channelTargetSchema(options?: {
    description?: string;
}): Type.TString;
export declare function channelTargetsSchema(options?: {
    description?: string;
}): Type.TArray<Type.TString>;
