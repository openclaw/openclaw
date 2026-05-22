import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
type ProviderToolSchemaParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
    tools: AgentTool<TSchemaType, TResult>[];
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    modelId?: string;
    modelApi?: string | null;
    model?: ProviderRuntimeModel;
};
/**
 * Runs provider-owned tool-schema normalization without encoding provider
 * families in the embedded runner.
 */
export declare function normalizeProviderToolSchemas<TSchemaType extends TSchema = TSchema, TResult = unknown>(params: ProviderToolSchemaParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[];
/**
 * Logs provider-owned tool-schema diagnostics after normalization.
 */
export declare function logProviderToolSchemaDiagnostics(params: ProviderToolSchemaParams): void;
export {};
