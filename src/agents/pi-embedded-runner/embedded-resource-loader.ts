import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import { DefaultResourceLoader, type ExtensionFactory } from "@mariozechner/pi-coding-agent";

export async function createEmbeddedResourceLoader(params: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  extensionFactories: ExtensionFactory[];
  systemPrompt: string;
}): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: params.cwd,
    agentDir: params.agentDir,
    settingsManager: params.settingsManager,
    extensionFactories: params.extensionFactories,
    // Embedded runner uses its own skill/context file injection.
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    systemPromptOverride: () => params.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}
