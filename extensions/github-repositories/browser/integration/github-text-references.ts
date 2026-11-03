import type { MarkdownRenderOptions } from "../../../../ui/src/components/markdown-render-options.ts";
import {
  prepareMarkdownTextReferenceSnapshot,
  prepareMarkdownTextReferences,
} from "../../../../ui/src/components/markdown-text-references.ts";
import { githubTextReferenceSnapshot } from "../text-reference-api.ts";

/** Rendering fixtures use the registered provider's immutable explicit-reference resolver. */
export function githubReferenceOptions(options: MarkdownRenderOptions = {}): MarkdownRenderOptions {
  return {
    ...options,
    textReferences: prepareMarkdownTextReferences([
      prepareMarkdownTextReferenceSnapshot(githubTextReferenceSnapshot()),
      ...(options.textReferences?.snapshots ?? []),
    ]),
  };
}
