import { n as createLazyRuntimeMethodBinder, r as createLazyRuntimeModule } from "../lazy-runtime-D-7_JraP.js";
//#region src/plugin-sdk/provider-auth-login.ts
/**
* @deprecated Compatibility subpath for provider-owned login helpers.
* Use provider auth hooks instead of importing bundled provider login commands.
*/
const bindProviderAuthLoginRuntime = createLazyRuntimeMethodBinder(createLazyRuntimeModule(() => import("../provider-auth-login.runtime-ReJ0S728.js")));
/** @deprecated GitHub Copilot provider-owned login helper; use provider auth hooks instead. */
const githubCopilotLoginCommand = bindProviderAuthLoginRuntime((runtime) => runtime.githubCopilotLoginCommand);
/** @deprecated Chutes provider-owned login helper; use provider auth hooks instead. */
const loginChutes = bindProviderAuthLoginRuntime((runtime) => runtime.loginChutes);
/** @deprecated OpenAI Codex provider-owned login helper; use provider auth hooks instead. */
const loginOpenAICodexOAuth = bindProviderAuthLoginRuntime((runtime) => runtime.loginOpenAICodexOAuth);
//#endregion
export { githubCopilotLoginCommand, loginChutes, loginOpenAICodexOAuth };
