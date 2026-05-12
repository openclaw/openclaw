import { DefaultResourceLoader } from "../pi-coding-agent-contract.js";

type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

export const EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} satisfies Partial<DefaultResourceLoaderInit>;

export function createEmbeddedPiResourceLoader(
  options: Pick<
    DefaultResourceLoaderInit,
    "cwd" | "agentDir" | "settingsManager" | "extensionFactories"
  >,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    ...options,
    ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
  });
}
