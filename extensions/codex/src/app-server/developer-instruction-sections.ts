export function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

/** Label the OpenClaw carrier, not the enclosing native developer message or inference relay. */
export function renderCodexThreadPolicy(...sections: Array<string | undefined>): string {
  return `<thread_policy>\n${joinPresentSections(...sections)}\n</thread_policy>`;
}
