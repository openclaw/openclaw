const TOOLKIT_SLUG_ALIASES: Record<string, string> = {
  x: "x",
  twitter: "x",
  googlecalendar: "google-calendar",
  "google-calendar": "google-calendar",
  googlesheets: "google-sheets",
  "google-sheets": "google-sheets",
  googledrive: "google-drive",
  "google-drive": "google-drive",
  googledocs: "google-docs",
  "google-docs": "google-docs",
};

const TOOLKIT_LOOKUP_CANDIDATES: Record<string, string[]> = {
  x: ["twitter", "x"],
  "google-calendar": ["google calendar", "googlecalendar", "google-calendar"],
  "google-sheets": ["google sheets", "googlesheets", "google-sheets"],
  "google-drive": ["google drive", "googledrive", "google-drive"],
  "google-docs": ["google docs", "googledocs", "google-docs"],
};

const TOOLKIT_CONNECT_SLUGS: Record<string, string> = {
  x: "twitter",
  "google-calendar": "googlecalendar",
  "google-sheets": "googlesheets",
  "google-drive": "googledrive",
  "google-docs": "googledocs",
};

export function normalizeComposioToolkitSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  return TOOLKIT_SLUG_ALIASES[normalized] ?? normalized;
}

export function getComposioToolkitLookupCandidates(slug: string): string[] {
  const normalized = normalizeComposioToolkitSlug(slug);
  return TOOLKIT_LOOKUP_CANDIDATES[normalized] ?? [normalized];
}

export function normalizeComposioToolkitName(name: string | undefined, slug: string): string {
  const normalizedSlug = normalizeComposioToolkitSlug(slug);
  if (normalizedSlug === "x") {
    return "X";
  }
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }
  return normalizedSlug;
}

export function resolveComposioConnectToolkitSlug(slug: string): string {
  const normalized = normalizeComposioToolkitSlug(slug);
  return TOOLKIT_CONNECT_SLUGS[normalized] ?? slug.trim().toLowerCase();
}
