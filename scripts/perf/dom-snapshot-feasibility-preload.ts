/** Rig-only: replay a synthetic settled page; no application or persisted-cache changes. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium, type Page } from "playwright";

const output = path.resolve(process.env.L303_OUTPUT ?? ".local/l303/captures");
if (!output.startsWith(`${path.resolve(".local")}${path.sep}`)) {
  throw new Error("L303 output must be in this checkout's .local/");
}
await mkdir(output, { recursive: true });
const aa = process.env.L303_AA === "1";
let sequence = 0;

function captureDom() {
  const started = performance.now();
  const app = document.querySelector("openclaw-app");
  if (!app || !document.querySelector(".chat-virtual-row")) return null;
  const inertDocument = document.implementation.createHTMLDocument();
  const scrolls: Array<{ index: number; top: number; left: number }> = [];
  let nodes = 0,
    elements = 0,
    excluded = 0,
    shadows = 0;
  const copy = (source: Node): Node | null => {
    nodes++;
    if (source.nodeType === Node.TEXT_NODE)
      return inertDocument.createTextNode(source.textContent ?? "");
    if (!(source instanceof Element)) return null;
    if (source.matches("script,iframe,object,embed,base,meta,link")) {
      excluded++;
      return null;
    }
    const target = inertDocument.createElementNS(source.namespaceURI, source.localName);
    const index = elements++;
    for (const attribute of source.attributes) {
      if (
        /^on/i.test(attribute.name) ||
        /^(?:srcdoc|elementtiming|autofocus)$/i.test(attribute.name) ||
        /^(?:javascript|vbscript):/i.test(attribute.value.replace(/[\s\x00-\x20]/g, ""))
      )
        continue;
      target.setAttribute(attribute.name, attribute.value);
    }
    if (source instanceof HTMLElement && (source.scrollTop || source.scrollLeft))
      scrolls.push({ index, top: source.scrollTop, left: source.scrollLeft });
    if (source instanceof HTMLInputElement) {
      target.setAttribute("value", source.value);
      target.toggleAttribute("checked", source.checked);
    }
    if (source instanceof HTMLImageElement && source.currentSrc)
      target.setAttribute("src", source.currentSrc);
    if (source.shadowRoot) {
      shadows++;
      const template = inertDocument.createElement("template");
      template.setAttribute("data-l303-shadow", "");
      for (const child of source.shadowRoot.childNodes) {
        const cloned = copy(child);
        if (cloned) template.content.append(cloned);
      }
      target.append(template);
    }
    for (const child of source.childNodes) {
      const cloned = copy(child);
      if (cloned) target.append(cloned);
    }
    return target;
  };
  const markup = (copy(app) as Element).outerHTML;
  // Selectors and inherited theme facts stay outside the app's own lookup tree.
  const rootStyle = getComputedStyle(document.documentElement);
  const properties = [...rootStyle]
    .filter((name) => name.startsWith("--"))
    .map((name) => [name, rootStyle.getPropertyValue(name)]);
  const styles = [...document.querySelectorAll('style,link[rel="stylesheet"]')]
    .filter((element) => !element.closest("openclaw-app"))
    .map((element) => element.outerHTML);
  const rect = app.getBoundingClientRect().toJSON();
  return {
    markup,
    styles,
    properties,
    scrolls,
    rect,
    htmlAttributes: [...document.documentElement.attributes].map((attribute) => [
      attribute.name,
      attribute.value,
    ]),
    bodyAttributes: [...document.body.attributes].map((attribute) => [
      attribute.name,
      attribute.value,
    ]),
    metrics: { nodes, elements, excluded, shadows, serializationMs: performance.now() - started },
  };
}

function replayDom(input: {
  snapshot: NonNullable<ReturnType<typeof captureDom>>;
  replay: boolean;
  sequence: number;
  url: string;
}) {
  if (window !== window.top || location.href !== input.url) return;
  const data = {
    sequence: input.sequence,
    replay: input.replay,
    insertedMs: null as number | null,
    parseMs: null as number | null,
    stylesReadyMs: null as number | null,
    restoreScrollMs: null as number | null,
    snapshotPaintMs: null as number | null,
    liveRowsPaintMs: null as number | null,
    liveDetailsPaintMs: null as number | null,
    swapMs: null as number | null,
    images: [] as Array<{ complete: boolean; decoded: boolean; visible: boolean }>,
  };
  Reflect.set(window, "__l303", data);
  let overlay: HTMLElement | undefined, root: ShadowRoot | undefined;
  let reported = false;
  const report = () => {
    if (!reported) {
      reported = true;
      console.debug("L303_RESULT:" + JSON.stringify(data));
    }
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const id: unknown = Reflect.get(entry, "identifier");
      const time: unknown = Reflect.get(entry, "renderTime");
      if (typeof time !== "number" || time <= 0) continue;
      if (id === "l303-snapshot") data.snapshotPaintMs ??= time;
      if (typeof id === "string" && /^openclaw-transcript(?:-(?:saved|live))?$/.test(id))
        data.liveRowsPaintMs ??= time;
      if (id === "openclaw-details") data.liveDetailsPaintMs ??= time;
    }
  }).observe({ type: "element", buffered: true });
  const insert = async () => {
    if (!document.documentElement || overlay || !input.replay) return;
    const started = performance.now();
    overlay = document.createElement("div");
    overlay.inert = true;
    overlay.setAttribute("aria-hidden", "true");
    const box = input.snapshot.rect;
    overlay.style.cssText = `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;z-index:2147483647;overflow:hidden;pointer-events:none;visibility:hidden;background:${getComputedStyle(document.documentElement).backgroundColor}`;
    // An empty scoped registry keeps inert custom-element markup from starting a second app.
    const registry = new CustomElementRegistry();
    root = overlay.attachShadow({
      mode: "closed",
      customElementRegistry: registry,
    } as ShadowRootInit);
    const html = document.createElement("html", {
      customElementRegistry: registry,
    } as ElementCreationOptions);
    for (const [name, value] of input.snapshot.htmlAttributes) html.setAttribute(name!, value!);
    for (const [name, value] of input.snapshot.properties) overlay.style.setProperty(name!, value!);
    root.append(html);
    // The parse context must carry the empty registry too: a global-registry
    // container would upgrade its descendants despite its scoped parent.
    html.innerHTML = `<head>${input.snapshot.styles.join("")}</head><body>${input.snapshot.markup}</body>`;
    const body = html.querySelector("body")!;
    for (const [name, value] of input.snapshot.bodyAttributes) body.setAttribute(name!, value!);
    const hydrate = (scope: ParentNode) => {
      for (const template of scope.querySelectorAll<HTMLTemplateElement>(
        "template[data-l303-shadow]",
      )) {
        const host = template.parentElement!;
        const shadow = host.attachShadow({
          mode: "open",
          customElementRegistry: new CustomElementRegistry(),
        } as ShadowRootInit);
        shadow.innerHTML = template.innerHTML;
        template.remove();
        hydrate(shadow);
      }
    };
    hydrate(body);
    document.documentElement.append(overlay);
    const elements: Element[] = [];
    const visit = (element: Element) => {
      elements.push(element);
      if (element.shadowRoot) for (const child of element.shadowRoot.children) visit(child);
      for (const child of element.children) visit(child);
    };
    const app = body.firstElementChild!;
    visit(app);
    data.insertedMs = performance.now();
    data.parseMs = data.insertedMs - started;
    await Promise.all(
      [...root.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) =>
        link.sheet
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              link.addEventListener("load", () => resolve(), { once: true });
              link.addEventListener("error", () => resolve(), { once: true });
            }),
      ),
    );
    data.stylesReadyMs = performance.now();
    const scrollStarted = performance.now();
    for (const scroll of input.snapshot.scrolls)
      elements[scroll.index]?.scrollTo(scroll.left, scroll.top);
    data.restoreScrollMs = performance.now() - scrollStarted;
    root
      .querySelector(".chat-text p, .chat-text, .chat-virtual-row")
      ?.setAttribute("elementtiming", "l303-snapshot");
    overlay.style.visibility = "visible";
    requestAnimationFrame(() => {
      data.images = [...root!.querySelectorAll("img")].map((image) => {
        const rect = image.getBoundingClientRect();
        return {
          complete: image.complete,
          decoded: image.naturalWidth > 0,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.y < innerHeight &&
            rect.right > 0 &&
            rect.x < innerWidth,
        };
      });
    });
  };
  const observer = new MutationObserver(() => {
    insert();
    if (overlay) observer.disconnect();
  });
  if (input.replay) {
    observer.observe(document, { childList: true, subtree: true });
    insert();
  }
  let complete = false;
  const frame = () => {
    const details = document.querySelector(".chat-details");
    const needsDetails = !!details && details.getBoundingClientRect().width > 0;
    if (
      (!input.replay || data.stylesReadyMs) &&
      data.liveRowsPaintMs &&
      (!needsDetails || data.liveDetailsPaintMs)
    ) {
      if (!complete) {
        complete = true;
        requestAnimationFrame(() => {
          overlay?.remove();
          data.swapMs = performance.now();
          requestAnimationFrame(report);
        });
      }
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.addEventListener("pagehide", report, { once: true });
}

async function instrument(page: Page) {
  let armed = false;
  const context = page.context();
  const session = await context.newCDPSession(page);
  await session.send("Page.enable");
  const originalNewSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (...args) => {
    const cdp = await originalNewSession(...args);
    if (args[0] !== page) return cdp;
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params) => {
      if (method === "Page.startScreencast") armed = true;
      return send(method, params);
    };
    return cdp;
  };
  let script: string | undefined;
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("L303_RESULT:")) {
      const result = JSON.parse(text.slice("L303_RESULT:".length)) as { sequence: number };
      void writeFile(
        path.join(output, `${result.sequence}.result.json`),
        JSON.stringify(result, null, 2),
      );
    }
  });
  const prepare = async () => {
    if (!armed) return;
    armed = false;
    const url = page.url();
    if (new URL(url).hostname !== "127.0.0.1")
      throw new Error("L303 only instruments owned loopback pages");
    const snapshot = await page.evaluate<ReturnType<typeof captureDom>>(
      `(() => { const __name=(fn)=>fn; return (${captureDom.toString()})(); })()`,
    );
    if (!snapshot) return;
    const index = sequence++;
    const replay = !aa && (index % 4 === 1 || index % 4 === 2);
    const { markup, metrics, rect } = snapshot;
    await writeFile(
      path.join(output, `${index}.capture.json`),
      JSON.stringify(
        {
          sequence: index,
          pair: Math.floor(index / 2),
          replay,
          url: new URL(page.url()).pathname,
          metrics,
          rect,
          rawBytes: Buffer.byteLength(markup),
          gzipBytes: gzipSync(markup).byteLength,
        },
        null,
        2,
      ),
    );
    if (script)
      await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script });
    script = (
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `const __name=(fn)=>fn;(${replayDom.toString()})(${JSON.stringify({ snapshot, replay, sequence: index, url })})`,
      })
    ).identifier;
  };
  const reload = page.reload.bind(page);
  page.reload = async (...args) => {
    await prepare();
    return reload(...args);
  };
  const goto = page.goto.bind(page);
  page.goto = async (...args) => {
    await prepare();
    return goto(...args);
  };
}

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...contextArgs) => {
    const context = await newContext(...contextArgs);
    const newPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      const page = await newPage(...pageArgs);
      await instrument(page);
      return page;
    };
    return context;
  };
  return browser;
};
