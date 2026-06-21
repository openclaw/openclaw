/** Joins non-empty Codex prompt sections with stable paragraph spacing. */
export function joinCodexPromptSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}
