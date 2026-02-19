import type { Page } from "playwright";

// Unchecked checkbox elements within list items
const UNCHECKED_SELECTOR = '[role="checkbox"][aria-checked="false"]';
// A stable container that Keep renders around the note body; used to detect
// when a newly-navigated note has finished mounting (bug #3 fix).
const NOTE_CONTAINER_SELECTOR = '[data-note-id], [jscontroller][data-expanded="true"]';

/**
 * Extract the text of every unchecked list item visible on the page.
 * Returns an empty array when no checkboxes are found (e.g. non-list note).
 *
 * Bug #4 fix: accepts timeoutMs so callers can pass the configured value.
 * Bug #3 fix: waits for the note container to (re-)mount before querying
 * checkboxes, preventing stale results when navigating between notes in the SPA.
 */
export async function extractUncheckedItems(page: Page, timeoutMs: number): Promise<string[]> {
  // Wait for Keep to mount the note body. If the selector is unknown/absent we
  // fall through and rely on the checkbox wait below.
  await page.waitForSelector(NOTE_CONTAINER_SELECTOR, { timeout: timeoutMs }).catch(() => {});

  try {
    await page.waitForSelector(UNCHECKED_SELECTOR, { timeout: timeoutMs });
  } catch {
    // No unchecked checkboxes found — not a list note, or all items are checked
    return [];
  }

  return page.evaluate((selector) => {
    const items: string[] = [];
    const checkboxes = document.querySelectorAll(selector);
    for (const cb of checkboxes) {
      const listitem = cb.closest('[role="listitem"]');
      if (!listitem) continue;
      const text = (listitem.textContent ?? "").trim();
      if (text) items.push(text);
    }
    return items;
  }, UNCHECKED_SELECTOR);
}
