import { DefaultResourceLoader } from "../sessions/resource-loader.js";

type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Embedded sessions consume prepared resources, never ambient local discovery. */
export function createEmbeddedAgentResourceLoader(
  options: Pick<
    DefaultResourceLoaderInit,
    | "cwd"
    | "agentDir"
    | "settingsManager"
    | "extensionFactories"
    | "agentsFilesOverride"
    | "appendSystemPromptTransform"
  >,
): DefaultResourceLoader {
  return new DefaultResourceLoader(options);
}
