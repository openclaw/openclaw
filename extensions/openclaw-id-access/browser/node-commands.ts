/** Quote one POSIX shell argument, including apostrophes and shell substitutions. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Pure browser-only formatting: never send these secret-bearing commands to an RPC. */
export function buildNodeJoinCommands(input: {
  joinLink: string;
  discoveryUrl: string | null;
  version: string;
}): { command: string; installedCommand: string } | null {
  if (input.discoveryUrl === null) {
    return null;
  }
  const suffix = `node join ${quote(input.joinLink)} --discovery-url ${quote(input.discoveryUrl)} --service`;
  return {
    command: `npx -y ${quote(`openclaw@${input.version}`)} ${suffix}`,
    installedCommand: `openclaw ${suffix}`,
  };
}
