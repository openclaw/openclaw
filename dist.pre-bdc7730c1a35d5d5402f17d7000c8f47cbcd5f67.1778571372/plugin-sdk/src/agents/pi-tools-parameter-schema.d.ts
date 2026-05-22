import type { TSchema } from "typebox";
import type { ModelCompatConfig } from "../config/types.models.js";
export type ToolParameterSchemaOptions = {
    modelProvider?: string;
    modelId?: string;
    modelCompat?: ModelCompatConfig;
};
export declare function normalizeToolParameterSchema(schema: unknown, options?: {
    modelProvider?: string;
    modelId?: string;
    modelCompat?: ModelCompatConfig;
}): TSchema;
