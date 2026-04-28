/**
 * Preserve the current page path when switching locales via the Mintlify
 * language dropdown. Without this, Mintlify navigates to the target
 * locale's homepage instead of the equivalent page.
 *
 * The dropdown items are <div role="menuitem"> elements (not <a> links)
 * with no href. Each item's id encodes the Mintlify language code, e.g.
 * "localization-select-item-zh-Hans". We map that to the URL prefix
 * used in docs.json navigation (e.g. "zh-Hans" → "zh-CN") and navigate
 * directly.
 */
(() => {
  const SELECTOR_CONTENT = "#localization-select-content";
  const SELECTOR_ITEM = '[data-component-part="localization-select-item"]';
  const ITEM_ID_PREFIX = "localization-select-item-";

  // Mintlify language code → URL path prefix.
  // Entries where the code itself is the prefix are omitted;
  // only the mismatches need listing here.
  const LOCALE_TO_PREFIX = {
    en: "",
    "zh-Hans": "zh-CN",
    ja: "ja-JP",
  };

  // All known URL prefixes, used to strip the current locale from the path.
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

  const prefixFor = (locale) =>
    locale in LOCALE_TO_PREFIX ? LOCALE_TO_PREFIX[locale] : locale;

  const localeFromId = (id) => {
    if (!id.startsWith(ITEM_ID_PREFIX)) return null;
    return id.slice(ITEM_ID_PREFIX.length) || null;
  };

  const currentPrefix = () => {
    const seg = location.pathname.split("/")[1];
    return KNOWN_PREFIXES.has(seg) ? seg : "";
  };

  const cleanPath = (pathname) => {
    for (const prefix of KNOWN_PREFIXES) {
      if (pathname === `/${prefix}` || pathname.startsWith(`/${prefix}/`)) {
        return pathname.slice(prefix.length + 1) || "/";
      }
    }
    return pathname;
  };

  const handleClick = (event) => {
    const item = event.target.closest(SELECTOR_ITEM);
    if (!item || item.dataset.selected === "true") return;

    const locale = localeFromId(item.id);
    if (!locale) return;

    const targetPrefix = prefixFor(locale);
    const activePrefix = currentPrefix();

    // Already on the target locale — let Mintlify handle it.
    if (targetPrefix === activePrefix) return;

    event.preventDefault();
    event.stopPropagation();

    const base = cleanPath(location.pathname);
    const targetPath = targetPrefix ? `/${targetPrefix}${base}` : base;
    window.location.href = `${targetPath}${location.search}${location.hash}`;
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
