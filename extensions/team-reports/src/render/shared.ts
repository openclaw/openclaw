import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { GITHUB_ITEM_KINDS } from "../github-item-kinds.js";
import type { GithubCounts, PersonReport } from "../types.js";

export function metric(label: string, value: string | number, detail = "", trend = ""): string {
  return `<div class="oc-summary-metric"><span class="oc-summary-metric-copy"><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}${trend}</span></div>`;
}

export function renderAvatar(
  login: string,
  display: string,
  size: "xs" | "sm" | "md" | "xl",
): string {
  const words = (display.trim() || login).split(/\s+/);
  const initials = (
    words.length > 1
      ? `${Array.from(words[0] ?? "")[0] ?? ""}${Array.from(words.at(-1) ?? "")[0] ?? ""}`
      : Array.from(words[0] ?? "")
          .slice(0, 2)
          .join("")
  ).toUpperCase();
  const pixels = { xs: 20, sm: 36, md: 40, xl: 72 }[size];
  const image = /^[A-Za-z0-9-]{1,39}$/.test(login)
    ? `<img src="https://avatars.githubusercontent.com/${escapeHtml(login)}?s=${pixels}" width="${pixels}" height="${pixels}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : "";
  return `<span class="oc-avatar oc-avatar-${size}" data-initials="${escapeHtml(initials)}">${image}</span>`;
}

export function safeExternalUrl(value: string): string | undefined {
  const url = URL.parse(value);
  return url &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password
    ? url.href
    : undefined;
}

export function countDescription(counts: GithubCounts): string {
  return (
    Object.values(GITHUB_ITEM_KINDS)
      .filter(({ field }) => counts[field] > 0)
      .map(({ field, plural }) => `${counts[field]} ${plural}`)
      .join(" · ") || "No GitHub activity recorded."
  );
}

export function memberSummary(member: PersonReport): string {
  return (
    member.summary?.text ??
    (member.github.total + member.discord.total === 0
      ? "No GitHub activity or Discord messages recorded in this period."
      : `${member.github.total} GitHub events and ${member.discord.total} Discord messages recorded in this period.`)
  );
}
