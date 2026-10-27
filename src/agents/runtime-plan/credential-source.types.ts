import type { ProviderModelAuthSourceClassification } from "../provider-model-auth-source-plan.js";

/** Secret-free credential source shared by runtime planning and terminal results. */
export type AgentRuntimeCredentialSource = ProviderModelAuthSourceClassification | { kind: "none" };
