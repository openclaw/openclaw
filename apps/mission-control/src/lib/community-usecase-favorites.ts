const COMMUNITY_USECASE_FAVORITES_KEY = "oc_usecase_template_favorites";
const MAX_FAVORITES = 32;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadCommunityUsecaseFavorites(): string[] {
  if (!isBrowser()) {return [];}
  try {
    const raw = window.localStorage.getItem(COMMUNITY_USECASE_FAVORITES_KEY);
    if (!raw) {return [];}
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {return [];}
    return parsed
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function saveCommunityUsecaseFavorites(ids: string[]): void {
  if (!isBrowser()) {return;}
  try {
    const normalized = Array.from(
      new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))
    ).slice(0, MAX_FAVORITES);
    window.localStorage.setItem(
      COMMUNITY_USECASE_FAVORITES_KEY,
      JSON.stringify(normalized)
    );
  } catch {
    // Ignore storage errors.
  }
}

export function toggleCommunityUsecaseFavorite(
  currentIds: string[],
  targetId: string
): string[] {
  const exists = currentIds.includes(targetId);
  if (exists) {
    return currentIds.filter((id) => id !== targetId);
  }
  return [targetId, ...currentIds].slice(0, MAX_FAVORITES);
}
