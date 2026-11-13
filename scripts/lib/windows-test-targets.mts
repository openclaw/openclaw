/** The two package scripts are the authoritative Windows test inventory. */
export function readWindowsTargets(scripts: Readonly<Record<string, unknown>>): string[] {
  const targets = [1, 2].flatMap((part) => {
    const script = scripts[`test:windows:ci:${part}`];
    const match =
      typeof script === "string" ? script.match(/^node scripts\/test-projects\.mts (.+)$/u) : null;
    const files = match?.[1]?.trim().split(/\s+/u);
    if (!files?.length || files.some((file) => !/^[\w./-]+\.test\.tsx?$/u.test(file))) {
      throw new Error(`Windows CI part ${part} must declare explicit test-projects file targets`);
    }
    return files;
  });
  if (new Set(targets).size !== targets.length) {
    throw new Error("Windows CI package scripts must not repeat a test file");
  }
  return targets;
}
