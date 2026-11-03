import type { ControlUiTextReferenceProvider } from "openclaw/plugin-sdk/control-ui";
import { githubTextReferenceSnapshot } from "./text-reference-grammar.ts";

/** Explicit references need no checkout, project catalog, or background reads. */
export function createGitHubTextReferenceProvider(): ControlUiTextReferenceProvider {
  const snapshot = githubTextReferenceSnapshot();
  return {
    id: "github-references",
    reader: { pluginId: "github", id: "github" },
    snapshot: () => snapshot,
  };
}
