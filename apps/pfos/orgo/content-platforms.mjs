const PLATFORM_RULES = {
  youtube: { hookChars: 120, bodyStyle: "long_form", cta: "Subscribe for the next breakdown." },
  tiktok: { hookChars: 80, bodyStyle: "short_form", cta: "Follow for part 2." },
  reels: { hookChars: 90, bodyStyle: "short_form", cta: "Save this and follow for more." },
  shorts: { hookChars: 90, bodyStyle: "short_form", cta: "Subscribe for daily shorts." },
  x: { hookChars: 220, bodyStyle: "thread_tease", cta: "Reply 'guide' for the full breakdown." },
  linkedin: { hookChars: 220, bodyStyle: "professional", cta: "Comment if you want the template." },
  facebook: { hookChars: 180, bodyStyle: "community", cta: "Share this with your team." },
};

function normalizePlatform(raw) {
  const p = String(raw ?? "youtube").toLowerCase();
  if (p === "twitter") return "x";
  if (p === "ig" || p === "instagram") return "reels";
  return PLATFORM_RULES[p] ? p : "youtube";
}

function defaultHashtags(niche, platform) {
  const base = [`#${String(niche ?? "content").replace(/\s+/g, "")}`, "#growth", "#marketing"];
  if (platform === "tiktok") return [...base, "#fyp"];
  if (platform === "youtube" || platform === "shorts") return [...base, "#youtube"];
  if (platform === "x") return [...base, "#buildinpublic"];
  return base;
}

export function buildContentDraft(input) {
  const platform = normalizePlatform(input?.platform);
  const niche = String(input?.niche ?? "business");
  const topic = String(input?.topic ?? "How to get results faster");
  const audience = String(input?.audience ?? "founders and operators");
  const tone = String(input?.tone ?? "clear and practical");
  const rules = PLATFORM_RULES[platform];

  const hook = `${topic} in under ${rules.hookChars} chars: practical steps for ${audience}.`.slice(0, rules.hookChars);
  const body = [
    `1) Context: why this matters for ${audience}.`,
    `2) Core insight: the highest-leverage move most teams skip.`,
    `3) Action: run this today and measure outcome within 7 days.`,
  ];

  return {
    platform,
    niche,
    topic,
    audience,
    tone,
    style: rules.bodyStyle,
    hook,
    body,
    cta: rules.cta,
    hashtags: defaultHashtags(niche, platform),
    variants: {
      titleA: `${topic}: Simple Framework`,
      titleB: `${topic} (No-Fluff Playbook)`,
      thumbnailA: `${topic} | 3 Steps`,
      thumbnailB: `Do This Today`,
    },
  };
}

export function buildMultiPlatformPack(input) {
  const platforms = Array.isArray(input?.platforms) && input.platforms.length
    ? input.platforms.map((p) => normalizePlatform(p))
    : ["youtube", "shorts", "tiktok", "reels", "x", "linkedin"];
  const unique = [...new Set(platforms)];
  return unique.map((platform) => buildContentDraft({ ...input, platform }));
}
