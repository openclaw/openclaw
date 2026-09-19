import type { BrowserTab } from "../browser/client.js";
import { defaultRuntime } from "./core-api.js";

export type BrowserTabFilters = { title?: string; urlContains?: string };

/** Filter the visible list without changing the ordinals used by tab select/close. */
export function selectBrowserTabs(tabs: BrowserTab[], filters: BrowserTabFilters = {}) {
  const title = filters.title?.toLowerCase() ?? "";
  const url = filters.urlContains?.toLowerCase() ?? "";
  return tabs
    .map((tab, index) => ({ tab, index }))
    .filter(
      ({ tab }) =>
        (!title || tab.title.toLowerCase().includes(title)) &&
        (!url || tab.url.toLowerCase().includes(url)),
    );
}

/** Render selected tabs with their original references and full-list ordinals. */
export function logBrowserTabs(tabs: ReturnType<typeof selectBrowserTabs>) {
  if (tabs.length === 0) {
    defaultRuntime.log("No tabs (browser closed or no targets).");
    return;
  }
  defaultRuntime.log(
    tabs
      .map(({ tab: t, index }) => {
        const labelHandle = t.label ? `label:${t.label}` : undefined;
        const suggested = t.suggestedTargetId ? `use: ${t.suggestedTargetId}` : undefined;
        const handles = [suggested, t.tabId ? `tab: ${t.tabId}` : undefined, labelHandle]
          .filter(Boolean)
          .join(" ");
        return `${index + 1}. ${t.title || "(untitled)"}${handles ? ` [${handles}]` : ""}\n   ${t.url}\n   id: ${t.targetId}`;
      })
      .join("\n"),
  );
}
