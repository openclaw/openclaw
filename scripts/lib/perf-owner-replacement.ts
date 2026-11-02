import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Keep the owner's module URL so replacement imports resolve through the same graph.
export function registerPerfOwnerReplacement(ownerUrl: string, ownerFile?: string): () => boolean {
  let replaced = false;
  if (ownerFile) {
    const replacement = pathToFileURL(path.resolve(ownerFile)).href;
    registerHooks({
      load(url, context, nextLoad) {
        if (url !== ownerUrl) {
          return nextLoad(url, context);
        }
        replaced = true;
        const result = nextLoad(replacement, context);
        return { format: result.format, source: result.source, shortCircuit: true };
      },
    });
  }
  return () => replaced;
}
