(() => {
  if (window !== window.top || window["__OPENCLAW_TAURI_I18N_READY__"]) {
    return;
  }
  const pageUrl = new URL(location.href);
  const localOrigin =
    (pageUrl.protocol === "tauri:" && pageUrl.hostname === "localhost" && pageUrl.port === "" &&
      pageUrl.username === "" && pageUrl.password === "") ||
    ((pageUrl.origin === "http://tauri.localhost" || pageUrl.origin === "https://tauri.localhost") &&
      pageUrl.username === "" && pageUrl.password === "");
  if (!localOrigin || !["/", "/index.html", "/gateways.html", "/quickchat.html"].includes(pageUrl.pathname)) {
    return;
  }

  const catalog = window["__OPENCLAW_TAURI_CATALOG__"];
  const hasCatalog =
    typeof catalog?.messages === "object" && catalog.messages !== null;
  const requestedLocale = window["__OPENCLAW_TAURI_LOCALE__"] === "pt-PT" ? "pt-PT" : "en";
  const locale = hasCatalog ? requestedLocale : "en";
  const format = (template, expectedArgs, args) => {
    const allowed = new Set(Array.isArray(expectedArgs) ? expectedArgs : []);
    const values = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const provided = Object.keys(values);
    if (provided.length !== allowed.size || provided.some((name) => !allowed.has(name))) {
      throw new TypeError("Tauri message arguments must exactly match the declaration");
    }
    for (const name of provided) {
      if (typeof values[name] !== "string" && typeof values[name] !== "number") {
        throw new TypeError(`Tauri message argument ${name} must be text or a number`);
      }
    }
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (token, name) => {
      if (!allowed.has(name)) {
        return token;
      }
      return String(values[name]);
    });
  };
  const argumentNames = (template) => [
    ...new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map((match) => match[1])),
  ];
  const fallbackText = (key, args = {}, fallback = key) => {
    return format(fallback, argumentNames(fallback), args);
  };
  const text = hasCatalog
    ? (key, args = {}, fallback = key) => {
        const entry = catalog.messages[key];
        const currentArgs = argumentNames(fallback);
        const currentEntry = entry?.en === fallback &&
          Array.isArray(entry.args) &&
          entry.args.length === currentArgs.length &&
          entry.args.every((name, index) => name === currentArgs[index]);
        const candidate = locale === "pt-PT" && currentEntry ? entry.ptPT : fallback;
        const message = typeof candidate === "string" ? candidate : fallback;
        return format(message, currentArgs, args);
      }
    : fallbackText;

  document.documentElement.lang = locale;
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = text(element.dataset.i18n, {}, element.textContent);
  }
  for (const attr of ["aria-label", "placeholder", "title"]) {
    const dataName = `i18n${attr.replace(/(^|-)([a-z])/gu, (_, _dash, letter) => letter.toUpperCase())}`;
    for (const element of document.querySelectorAll(`[data-i18n-${attr}]`)) {
      element.setAttribute(attr, text(element.dataset[dataName], {}, element.getAttribute(attr) ?? ""));
    }
  }
  Object.defineProperty(window, "__OPENCLAW_TAURI_I18N_READY__", {
    value: Promise.resolve({ locale, text }),
  });
})();
