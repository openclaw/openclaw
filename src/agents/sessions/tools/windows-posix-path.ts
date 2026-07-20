const WINDOWS_POSIX_DRIVE_PATH_RE = /^\/(?:cygdrive\/|mnt\/)?([a-z])(?:\/(.*))?$/i;

export function normalizeWindowsPosixDrivePath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return filePath;
  }
  const match = WINDOWS_POSIX_DRIVE_PATH_RE.exec(filePath);
  if (!match?.[1]) {
    return filePath;
  }
  const root = `${match[1].toUpperCase()}:\\`;
  return match[2] ? `${root}${match[2].replaceAll("/", "\\")}` : root;
}
