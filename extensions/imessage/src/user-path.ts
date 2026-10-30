// Home-directory helpers kept free of plugin-SDK imports: a plain `node` child
// process imports this module directly to verify `~` expansion against the real
// account home, so it must not depend on the SDK dist.
import os from "node:os";

export function resolveIMessageHomeDir(): string | undefined {
  const configuredHome = process.env.HOME;
  const home = configuredHome?.trim();
  if (home) {
    return home;
  }
  try {
    // On POSIX, os.homedir() echoes a defined blank HOME instead of querying the account.
    const systemHome = configuredHome === undefined ? os.homedir() : os.userInfo().homedir;
    return systemHome.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function expandIMessageHomePrefix(value: string, home: string | undefined): string {
  return home && value.startsWith("~") ? value.replace(/^~(?=$|[\\/])/, () => home) : value;
}

export function expandIMessageUserPath(value: string): string {
  return expandIMessageHomePrefix(value, resolveIMessageHomeDir());
}
