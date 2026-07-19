// Keep these limits in sync with browser/extension-relay/relay-protocol.ts.
export const PAGE_SHARE_MAX_CONTENT_CHARS = 120_000;
export const PAGE_SHARE_MAX_NOTE_CHARS = 2_000;
export const PAGE_SHARE_MAX_TITLE_CHARS = 500;
export const PAGE_SHARE_MAX_URL_CHARS = 2_000;

export function googleDocIdFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  if (parsed.hostname !== "docs.google.com") {
    return null;
  }
  return /^\/document\/d\/([^/]+)/u.exec(parsed.pathname)?.[1] ?? null;
}

export function truncateShareText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n\n[Truncated: original was ${value.length} characters]`;
}

export async function waitForCondition(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return condition();
}

export function buildPageSharePayload({ url, title, content, selection, note }) {
  // Collapse horizontal whitespace only. Newlines remain meaningful for
  // articles and extracted social threads.
  const normalizedContent = (typeof content === "string" ? content : "")
    .replace(/[ \t]+/gu, " ")
    .trim();
  const normalizedSelection = typeof selection === "string" ? selection.trim() : "";
  const normalizedNote = typeof note === "string" ? note.trim() : "";
  return {
    url: (typeof url === "string" ? url : "").trim().slice(0, PAGE_SHARE_MAX_URL_CHARS),
    title: (typeof title === "string" ? title : "").trim().slice(0, PAGE_SHARE_MAX_TITLE_CHARS),
    content: truncateShareText(normalizedContent, PAGE_SHARE_MAX_CONTENT_CHARS),
    ...(normalizedSelection
      ? { selection: truncateShareText(normalizedSelection, PAGE_SHARE_MAX_CONTENT_CHARS) }
      : {}),
    ...(normalizedNote ? { note: normalizedNote.slice(0, PAGE_SHARE_MAX_NOTE_CHARS) } : {}),
  };
}

/** Self-contained because chrome.scripting serializes this function source. */
export function capturePageContent() {
  const selection = window.getSelection()?.toString().trim() ?? "";
  const textOf = (node) =>
    String(Reflect.get(node ?? {}, "innerText") || node?.textContent || "").trim();
  const removeNoise = (root) => {
    const selectors = [
      "script",
      "style",
      "noscript",
      "nav",
      "footer",
      "header",
      "aside",
      "form",
      "button",
      "input",
      "textarea",
      "svg",
      "canvas",
      "iframe",
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
      '[aria-hidden="true"]',
      ".ad",
      ".ads",
      ".advert",
      ".advertisement",
      ".promo",
      ".subscribe",
      ".newsletter",
    ];
    for (const node of root.querySelectorAll(selectors.join(","))) {
      node.remove();
    }
  };

  let content = "";
  const hostname = window.location.hostname.toLowerCase();
  const isTwitter = /^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/u.test(hostname);
  if (isTwitter) {
    const primaryColumn = document.querySelector('div[data-testid="primaryColumn"]');
    if (primaryColumn) {
      const clone = primaryColumn.cloneNode(true);
      removeNoise(clone);
      for (const node of clone.querySelectorAll(
        '[role="button"], [role="progressbar"], [data-testid="sidebarColumn"], [data-testid="BottomBar"]',
      )) {
        node.remove();
      }
      content = textOf(clone);
    }
    if (!content) {
      const seen = new Set();
      const tweets = [];
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const user = textOf(article.querySelector('[data-testid="User-Name"]'));
        const tweetText = textOf(article.querySelector('[data-testid="tweetText"]'));
        const rendered = textOf(article);
        if (!rendered) {
          continue;
        }
        const key = `${user}|${(tweetText || rendered).slice(0, 240)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        tweets.push(`${article.getAttribute("tabindex") === "-1" ? ">>> " : ""}${rendered}`);
      }
      content = tweets.join("\n\n---\n\n");
    }
  } else {
    const clone = document.body?.cloneNode(true);
    if (clone) {
      removeNoise(clone);
      let bestText = "";
      let bestScore = 0;
      for (const candidate of clone.querySelectorAll(
        'article, main, [role="main"], section, div',
      )) {
        const text = textOf(candidate);
        const wordCount = text.split(/\s+/u).filter(Boolean).length;
        if (wordCount <= 80) {
          continue;
        }
        const score = wordCount + Math.min(2_000, text.length) / 10;
        if (score > bestScore) {
          bestScore = score;
          bestText = text;
        }
      }
      content = bestText || textOf(clone);
    }
    content ||= textOf(document.body);
  }

  return {
    url: window.location.href,
    title: document.title,
    selection,
    content,
  };
}

/** Self-contained so the request runs in the tab with the user's Google cookies. */
export async function fetchGoogleDocExportInTab(docId) {
  try {
    const response = await fetch(
      `https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=txt`,
      { credentials: "include" },
    );
    if (!response.ok) {
      return { error: `Google Docs export failed (${response.status}).` };
    }
    return { text: await response.text() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
