// macOS user helpers support Parallels guest fallback discovery.
export function parseMacosDsclUserHomeLine(line: string): { user: string; home: string } | null {
  const match = /^(\S+)\s+(.+?)\s*$/u.exec(line.replaceAll("\r", ""));
  if (!match) {
    return null;
  }
  return { user: match[1]!, home: match[2]! };
}

export function isLikelyMacosDesktopHome(home: string | undefined): boolean {
  const normalized = home?.trim();
  return normalized !== undefined && /(?:^|\/)Users\/[^/]+$/u.test(normalized);
}

type ReadGuestOutput = (args: string[]) => string;

export function resolveMacosDesktopUser(readOutput: ReadGuestOutput): string {
  const consoleUser =
    readOutput(["/usr/bin/stat", "-f", "%Su", "/dev/console"])
      .trim()
      .replaceAll("\r", "")
      .split("\n")
      .at(-1) ?? "";
  if (
    /^[A-Za-z0-9._-]+$/.test(consoleUser) &&
    consoleUser !== "root" &&
    consoleUser !== "loginwindow"
  ) {
    return consoleUser;
  }
  const users = readOutput([
    "/usr/bin/dscl",
    ".",
    "-list",
    "/Users",
    "NFSHomeDirectory",
  ]).replaceAll("\r", "");
  for (const line of users.split("\n")) {
    const parsed = parseMacosDsclUserHomeLine(line);
    const user = parsed?.user;
    if (
      user &&
      isLikelyMacosDesktopHome(parsed?.home) &&
      !user.startsWith("_") &&
      user !== "Shared" &&
      user !== ".localized"
    ) {
      return user;
    }
  }
  return "";
}

export function resolveMacosDesktopHome(user: string, readOutput: ReadGuestOutput): string {
  const output = readOutput([
    "/usr/bin/dscl",
    ".",
    "-read",
    `/Users/${user}`,
    "NFSHomeDirectory",
  ]).replaceAll("\r", "");
  const match = /^NFSHomeDirectory:\s+(.+)$/m.exec(output);
  return match?.[1]?.trim() || `/Users/${user}`;
}
