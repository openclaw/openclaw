function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, "");
  return trimmed.length > 0 ? trimmed : "/";
}

export function isValidCampfireUrl(value: string): boolean {
  return parseAbsoluteUrl(value) !== null;
}

export function isCampfireUrlInWorkspaceScope(targetUrl: string, baseUrl: string): boolean {
  const target = parseAbsoluteUrl(targetUrl);
  const base = parseAbsoluteUrl(baseUrl);
  if (!target || !base) {
    return false;
  }

  if (target.origin !== base.origin) {
    return false;
  }

  const basePath = normalizePath(base.pathname);
  if (basePath === "/") {
    return true;
  }

  const targetPath = normalizePath(target.pathname);
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}
