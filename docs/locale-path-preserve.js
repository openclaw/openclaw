/**
 * Preserve the current page path when switching locales via the Mintlify
 * language dropdown. Without this, Mintlify navigates to the target
 * locale's homepage instead of the equivalent page.
 *
 * Uses the same CSS selectors Mintlify documents for the localization
 * dropdown: #localization-select-content, #localization-select-item.
 */
(() => {
  const SELECTOR_CONTENT = "#localization-select-content";
  const SELECTOR_ITEM = "#localization-select-item";
  const KNOWN_PREFIXES = new Set([
    "zh-CN",
    "ja-JP",
    "es",
    "pt-BR",
    "ko",
    "de",
    "fr",
    "ar",
    "it",
    "tr",
    "uk",
    "id",
    "pl",
  ]);

  const cleanPath = (pathname) => {
    let path = pathname;
    for (const prefix of KNOWN_PREFIXES) {
      if (
        path === `/${prefix}` ||
        path.startsWith(`/${prefix}/`)
      ) {
        path = path.slice(prefix.length + 1) || "/";
        break;
      }
    }
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    return path;
  };

  const targetLocale = (href) => {
    const seg = new URL(href, location.origin).pathname.split("/")[1];
    return KNOWN_PREFIXES.has(seg) ? seg : "";
  };

  const handleClick = (event) => {
    const item = event.target.closest(SELECTOR_ITEM);
    if (!item) return;

    const href = item.getAttribute("href");
    if (!href) return;

    const locale = targetLocale(href);
    const currentLocale = (() => {
      const seg = location.pathname.split("/")[1];
      return KNOWN_PREFIXES.has(seg) ? seg : "";
    })();

    if (locale === currentLocale) return;

    event.preventDefault();
    event.stopPropagation();

    const base = cleanPath(location.pathname);
    const targetPath = locale ? `/${locale}${base}` : base;
    const url = `${targetPath}${location.search}${location.hash}`;
    window.location.href = url;
  };

  const attach = () => {
    const dropdown = document.querySelector(SELECTOR_CONTENT);
    if (!dropdown || dropdown.dataset.lpAttached) return;
    dropdown.dataset.lpAttached = "1";
    dropdown.addEventListener("click", handleClick, true);
  };

  const observer = new MutationObserver(attach);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      attach();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  } else {
    attach();
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
