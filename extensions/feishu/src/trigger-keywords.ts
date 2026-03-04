export type TriggerKeywordsConfig = {
  enabled?: boolean;
  keywords?: string[];
};

function normalizeText(text: string): string {
  // Mirror mention normalizer behavior: remove invisible formatting chars + lowercase.
  return (text ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").toLowerCase();
}

export function matchesTriggerKeywords(text: string, cfg?: TriggerKeywordsConfig | null): boolean {
  if (!cfg || cfg.enabled !== true) {
    return false;
  }
  const keywords = (cfg.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (keywords.length === 0) {
    return false;
  }
  const cleaned = normalizeText(text);
  if (!cleaned) {
    return false;
  }
  return keywords.some((kw) => cleaned.includes(normalizeText(kw)));
}
