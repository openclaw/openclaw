import path from "node:path";

/**
 * Skill Library pins live in the Gateway state directory, which a remote app-server's
 * own file tools cannot open; copies already delivered under its workspace root stay.
 */
export function resolveGatewayOnlySkillDirs(
  skills: readonly { name: string; source: string; filePath: string }[],
  remoteWorkspaceRoot: string | undefined,
): Map<string, string> {
  const root = `${remoteWorkspaceRoot?.replace(/\/+$/u, "")}/`;
  const remote = skills.filter(
    (skill) =>
      remoteWorkspaceRoot &&
      skill.source === "openclaw-library" &&
      !skill.filePath.startsWith(root),
  );
  return new Map(remote.map((skill) => [skill.name, path.dirname(skill.filePath)]));
}

/**
 * Skill Library pins live in the Gateway state directory, which a remote app-server's
 * own file tools cannot open; copies already delivered under its workspace root stay.
 * The catalog arrives rendered (with compacted paths), so entries are matched by name.
 */
export function withoutGatewayOnlySkillLocations(
  prompt: string,
  skills: readonly { name: string; source: string; filePath: string }[],
  remoteRoot: string,
  readable: boolean,
): string {
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const names = new Set(
    [...resolveGatewayOnlySkillDirs(skills, remoteRoot).keys()].map(
      (name) => `    <name>${escape(name)}</name>`,
    ),
  );
  const note = readable
    ? "Stored on the Gateway: read it with skills_read by name."
    : "Stored on the Gateway: its instructions cannot be read on this machine.";
  return names.size === 0
    ? prompt
    : prompt.replace(/^ {2}<skill>\n[\s\S]*?\n {2}<\/skill>$/gmu, (block) =>
        block.split("\n").some((line) => names.has(line))
          ? block.replace(
              /^ {4}<location>.*<\/location>$/mu,
              `    <location_note>${note}</location_note>`,
            )
          : block,
      );
}
