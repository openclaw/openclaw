/** GitHub presentation loaded with the Markdown renderer. */
export {
  markdownGitHubAliases,
  markdownGitHubAliasSignature,
  type MarkdownGitHubRepository,
  type MarkdownGitHubRepositoryAliases,
  type MarkdownGitHubAliases,
} from "./browser/markdown-repositories.js";
export { createMarkdownGitHubRefsInstaller } from "./browser/markdown-refs.js";
export {
  decorateGitHubMarkdownLink,
  isGitHubCodeSpanUrl,
  GITHUB_ITEM_LINK_SELECTOR,
} from "./browser/markdown-links.js";
