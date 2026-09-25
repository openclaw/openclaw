type GitHubPluginPolicy = {
  enabled: boolean;
  allow: readonly string[];
  deny: readonly string[];
  entries: Record<string, { enabled?: boolean }>;
};

/** Explain the core-preview cutover without changing an operator's trust policy. */
export function collectGitHubUpgradeWarnings(policy: GitHubPluginPolicy): string[] {
  if (
    !policy.enabled ||
    policy.deny.includes("github") ||
    policy.entries.github?.enabled === false ||
    policy.allow.length === 0 ||
    policy.allow.includes("github")
  ) {
    return [];
  }
  return [
    '- GitHub link previews and the reader are now provided by the bundled "github" plugin. Your plugins.allow list excludes "github", so these features remain unavailable. To restore them, append "github" to the existing allowlist and enable it in Plugins. To keep them disabled without this notice, set plugins.entries.github.enabled=false. Doctor does not change either choice.',
  ];
}
