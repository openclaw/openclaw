import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

export const EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} satisfies Partial<DefaultResourceLoaderInit>;

/**
 * Lightweight resource loader that skips expensive packageManager.resolve().
 *
 * DefaultResourceLoader.reload() executes packageManager.resolve(), which
 * scans many directories (~/.pi/*, ~/.agents/skills, ancestor .agents/skills).
 * When all no* flags are true, the resolve() result is discarded (empty arrays).
 *
 * The constructor initializes:
 * - extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() }
 * - skills = [], prompts = [], themes = [], agentsFiles = []
 * - systemPrompt = undefined (until reload() sets it)
 *
 * These match reload()'s output when no* flags are true, except systemPrompt.
 * OpenClaw overrides systemPrompt via applySystemPromptOverrideToSession(),
 * so the undefined systemPrompt from skipped reload() is harmless.
 *
 * Inline extensionFactories are loaded by calling loadExtensionFactories()
 * directly, which only needs extensionsResult.runtime (already initialized).
 *
 * This eliminates the 5-9 second resolve() overhead on every embedded run.
 */
export async function createEmbeddedPiResourceLoader(
  options: Pick<
    DefaultResourceLoaderInit,
    "cwd" | "agentDir" | "settingsManager" | "extensionFactories"
  >,
): Promise<DefaultResourceLoader> {
  // Create loader with all discovery disabled
  const loader = new DefaultResourceLoader({
    ...options,
    ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
  });

  // Load inline extensionFactories directly, bypassing reload()
  // The loadExtensionFactories method is public and only needs runtime
  // which is already initialized in constructor as createExtensionRuntime()
  const runtime = (loader as any).extensionsResult.runtime;
  const inlineExtensions = await (loader as any).loadExtensionFactories(runtime);
  (loader as any).extensionsResult.extensions.push(...inlineExtensions.extensions);
  (loader as any).extensionsResult.errors.push(...inlineExtensions.errors);

  // Skip reload() entirely - the initial state matches what reload() would produce
  // with all no* flags true, and OpenClaw overrides systemPrompt separately

  return loader;
}

/**
 * Marker function called after resource loader creation.
 *
 * In the previous implementation, this updated cache metadata for TTL tracking.
 * In the current implementation, it's a no-op since we no longer cache loaders.
 * Kept for backward compatibility with callers that track reload timing.
 *
 * @param cwd - Workspace directory
 * @param agentDir - Agent directory
 */
export function markResourceLoaderReloaded(_cwd: string, _agentDir: string): void {
  // No-op: previous caching mechanism removed
}

/**
 * Synchronous creation for cases where extensionFactories is empty.
 * When no inline extensions are needed, we can skip the async factory loading.
 */
export function createEmbeddedPiResourceLoaderSync(
  options: Pick<
    DefaultResourceLoaderInit,
    "cwd" | "agentDir" | "settingsManager"
  > & { extensionFactories?: never },
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    ...options,
    ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
    extensionFactories: [],
  });
}