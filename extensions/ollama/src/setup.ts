import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";

export { resolveOllamaSetupDefaultBaseUrl } from "./defaults.js";
export { buildOllamaProvider } from "./provider-models.js";

const loadOllamaSetupRuntime = createLazyRuntimeModule(() => import("./setup.runtime.js"));
const setupMethod = createLazyRuntimeMethodBinder(loadOllamaSetupRuntime);

export const promptAndConfigureOllama = setupMethod((runtime) => runtime.promptAndConfigureOllama);
export const configureOllamaNonInteractive = setupMethod(
  (runtime) => runtime.configureOllamaNonInteractive,
);
export const ensureOllamaModelPulled = setupMethod((runtime) => runtime.ensureOllamaModelPulled);
