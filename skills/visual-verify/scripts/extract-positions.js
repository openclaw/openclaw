// extract-positions.js - Extract element positions for comparison
// Usage: npx playwright evaluate <URL> "$(cat extract-positions.js)"

(function () {
  const selectors = [
    "button",
    '[role="button"]',
    ".btn",
    "a.button",
    'input[type="submit"]',
    "h1",
    "h2",
    "h3",
    "nav",
    "header",
    "footer",
    ".container",
    ".hero",
    ".cta",
  ];

  const results = {
    url: window.location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    timestamp: new Date().toISOString(),
    elements: [],
  };

  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(el);

      // Skip invisible elements
      if (rect.width === 0 || rect.height === 0) return;

      const viewportCenter = window.innerWidth / 2;
      const elementCenter = rect.x + rect.width / 2;

      results.elements.push({
        selector: selector,
        index: index,
        text: el.textContent?.trim().substring(0, 50) || "",
        tag: el.tagName.toLowerCase(),
        position: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        centered: Math.abs(viewportCenter - elementCenter) < 10,
        centerOffset: Math.round(viewportCenter - elementCenter),
        css: {
          display: computedStyle.display,
          position: computedStyle.position,
          flexDirection: computedStyle.flexDirection,
          justifyContent: computedStyle.justifyContent,
          alignItems: computedStyle.alignItems,
        },
      });
    });
  });

  return JSON.stringify(results, null, 2);
})();
