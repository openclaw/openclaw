import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { type AnyAgentTool, type SandboxFsBridge, type ToolFsPolicy } from "./tool-runtime.helpers.js";
export declare const PdfToolSchema: Type.TObject<{
    prompt: Type.TOptional<Type.TString>;
    pdf: Type.TOptional<Type.TString>;
    pdfs: Type.TOptional<Type.TArray<Type.TString>>;
    pages: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TString>;
    maxBytesMb: Type.TOptional<Type.TNumber>;
}>;
export { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";
type PdfSandboxConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
export declare function createPdfTool(options?: {
    config?: OpenClawConfig;
    agentDir?: string;
    authProfileStore?: AuthProfileStore;
    workspaceDir?: string;
    sandbox?: PdfSandboxConfig;
    fsPolicy?: ToolFsPolicy;
    /**
     * Avoid resolving auto PDF-provider/model candidates while registering the
     * tool. The concrete PDF model is still resolved before execution.
     */
    deferAutoModelResolution?: boolean;
}): AnyAgentTool | null;
