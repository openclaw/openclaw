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
const pendingVisual = new Set<Promise<void>>();

function captureDom() {
  const started = performance.now();
  const app = document.querySelector("openclaw-app");
  if (!app || !document.querySelector(".chat-virtual-row")) {
    return null;
  }
  const inertDocument = document.implementation.createHTMLDocument();
  const scrolls: Array<{ index: number; top: number; left: number }> = [];
  let nodes = 0,
    elements = 0,
    excluded = 0,
    shadows = 0;
  const copy = (source: Node): Node | null => {
    nodes++;
    if (source.nodeType === Node.TEXT_NODE) {
      return inertDocument.createTextNode(source.textContent ?? "");
    }
    if (!(source instanceof Element)) {
      return null;
    }
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
        // URL parsing strips ASCII controls before recognizing executable schemes.
        // eslint-disable-next-line no-control-regex
        /^(?:javascript|vbscript):/i.test(attribute.value.replace(/[\s\x00-\x20]/g, ""))
      ) {
        continue;
      }
      target.setAttribute(attribute.name, attribute.value);
    }
    if (source instanceof HTMLElement && (source.scrollTop || source.scrollLeft)) {
      scrolls.push({ index, top: source.scrollTop, left: source.scrollLeft });
    }
    if (source instanceof HTMLInputElement) {
      target.setAttribute("value", source.value);
      target.toggleAttribute("checked", source.checked);
    }
    if (source instanceof HTMLImageElement && source.currentSrc) {
      target.setAttribute("src", source.currentSrc);
    }
    if (source.shadowRoot) {
      shadows++;
      const template = inertDocument.createElement("template");
      template.setAttribute("data-l303-shadow", "");
      for (const child of source.shadowRoot.childNodes) {
        const cloned = copy(child);
        if (cloned) {
          template.content.append(cloned);
        }
      }
      target.append(template);
    }
    for (const child of source.childNodes) {
      const cloned = copy(child);
      if (cloned) {
        target.append(cloned);
      }
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
  const fontRules: string[] = [];
  const readFonts = (rules: CSSRuleList, base: string) => {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        fontRules.push(
          rule.cssText.replace(
            /url\((['"]?)(.*?)\1\)/g,
            (_match, _quote, source: string) =>
              `url(${JSON.stringify(new URL(source, base).href)})`,
          ),
        );
      } else if (rule instanceof CSSGroupingRule) {
        readFonts(rule.cssRules, base);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    readFonts(sheet.cssRules, sheet.href ?? location.href);
  }
  const usedFonts = [...document.fonts]
    .filter((face) => face.status === "loaded")
    .map((face) => `${face.style} ${face.weight.split(" ")[0]} 16px ${face.family}`);
  const rect = app.getBoundingClientRect().toJSON();
  const viewport = { width: innerWidth, height: innerHeight };
  const background =
    [document.body, document.documentElement, app]
      .map((element) => getComputedStyle(element).backgroundColor)
      .find((color) => color !== "rgba(0, 0, 0, 0)" && color !== "transparent") ?? "white";
  const requiresDetails =
    (app.querySelector(".chat-details")?.getBoundingClientRect().width ?? 0) > 0;
  const requiresBoard = Boolean(app.querySelector("openclaw-board-view iframe"));
  return {
    markup,
    viewport,
    background,
    requiresDetails,
    requiresBoard,
    styles,
    fontRules,
    usedFonts,
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
  hold: boolean;
}) {
  if (window !== window.top || location.href !== input.url) {
    return;
  }
  const data = {
    sequence: input.sequence,
    replay: input.replay,
    insertedMs: null as number | null,
    parseMs: null as number | null,
    stylesReadyMs: null as number | null,
    fontsReadyMs: null as number | null,
    restoreScrollMs: null as number | null,
    snapshotPaintMs: null as number | null,
    liveRowsPaintMs: null as number | null,
    liveDetailsPaintMs: null as number | null,
    swapMs: null as number | null,
    images: [] as Array<{ complete: boolean; hasIntrinsicSize: boolean; visible: boolean }>,
  };
  Reflect.set(window, "__l303", data);
  let overlay: HTMLElement | undefined,
    root: ShadowRoot | undefined,
    fontStyle: HTMLStyleElement | undefined;
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
      if (typeof time !== "number" || time <= 0) {
        continue;
      }
      if (id === "l303-snapshot") {
        data.snapshotPaintMs ??= time;
      }
      if (typeof id === "string" && /^openclaw-transcript(?:-(?:saved|live))?$/.test(id)) {
        data.liveRowsPaintMs ??= time;
      }
      if (id === "openclaw-details") {
        data.liveDetailsPaintMs ??= time;
      }
    }
  }).observe({ type: "element", buffered: true });
  const insert = async () => {
    if (!document.documentElement || overlay || !input.replay) {
      return;
    }
    const started = performance.now();
    // Shadow styles do not register document fonts; preserve the old font metrics before reveal.
    fontStyle = document.createElement("style");
    fontStyle.textContent = input.snapshot.fontRules.join("\n");
    document.documentElement.append(fontStyle);
    const fontsReady = Promise.all(
      input.snapshot.usedFonts.map((font) => document.fonts.load(font)),
    );
    overlay = document.createElement("div");
    overlay.inert = true;
    overlay.setAttribute("aria-hidden", "true");
    const box = input.snapshot.rect;
    overlay.style.cssText = `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;z-index:2147483647;overflow:hidden;pointer-events:none;visibility:hidden;background:${input.snapshot.background}`;
    // An empty scoped registry keeps inert custom-element markup from starting a second app.
    const registry = new CustomElementRegistry();
    root = overlay.attachShadow({
      mode: "closed",
      customElementRegistry: registry,
    } as ShadowRootInit);
    const html = document.createElement("html", {
      customElementRegistry: registry,
    } as ElementCreationOptions);
    for (const [name, value] of input.snapshot.htmlAttributes) {
      html.setAttribute(name!, value!);
    }
    for (const [name, value] of input.snapshot.properties) {
      overlay.style.setProperty(name!, value!);
    }
    html.style.width = `${input.snapshot.viewport.width}px`;
    html.style.height = `${input.snapshot.viewport.height}px`;
    html.style.translate = `${-box.x}px ${-box.y}px`;
    root.append(html);
    // The parse context must carry the empty registry too: a global-registry
    // container would upgrade its descendants despite its scoped parent.
    html.innerHTML = `<head>${input.snapshot.styles.join("")}</head><body>${input.snapshot.markup}</body>`;
    const body = html.querySelector("body")!;
    for (const [name, value] of input.snapshot.bodyAttributes) {
      body.setAttribute(name!, value!);
    }
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
      if (element.shadowRoot) {
        for (const child of element.shadowRoot.children) {
          visit(child);
        }
      }
      for (const child of element.children) {
        visit(child);
      }
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
    await fontsReady;
    await document.fonts.ready;
    data.fontsReadyMs = performance.now();
    const scrollStarted = performance.now();
    for (const scroll of input.snapshot.scrolls) {
      elements[scroll.index]?.scrollTo(scroll.left, scroll.top);
    }
    data.restoreScrollMs = performance.now() - scrollStarted;
    root
      .querySelector(".chat-text p, .chat-text, .chat-virtual-row")
      ?.setAttribute("elementtiming", "l303-snapshot");
    overlay.style.visibility = "visible";
    requestAnimationFrame(() => {
      data.images = elements
        .filter((element): element is HTMLImageElement => element instanceof HTMLImageElement)
        .map((image) => {
          const rect = image.getBoundingClientRect();
          return {
            complete: image.complete,
            hasIntrinsicSize: image.naturalWidth > 0,
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
    void insert();
    if (overlay) {
      observer.disconnect();
    }
  });
  if (input.replay) {
    observer.observe(document, { childList: true, subtree: true });
    void insert();
  }
  let complete = false;
  const frame = () => {
    const proof = Reflect.get(window, "__warmReloadProof");
    const boardReady =
      !input.snapshot.requiresBoard || (proof && Reflect.get(proof, "firstDashboardContentDomMs"));
    if (
      (!input.replay || data.fontsReadyMs) &&
      data.liveRowsPaintMs &&
      (!input.snapshot.requiresDetails || data.liveDetailsPaintMs) &&
      boardReady
    ) {
      if (!complete) {
        complete = true;
        const swap = () => {
          overlay?.remove();
          fontStyle?.remove();
          data.swapMs = performance.now();
          requestAnimationFrame(report);
        };
        if (input.hold && input.replay) {
          Reflect.set(window, "__l303Swap", swap);
          console.debug("L303_READY:" + input.sequence);
        } else {
          requestAnimationFrame(swap);
        }
      }
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.addEventListener("pagehide", report, { once: true });
}

function installSnapshotWitness() {
  const observer = new MutationObserver(() => {
    const overlay = [...(document.documentElement?.children ?? [])].find(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element.inert &&
        element.getAttribute("aria-hidden") === "true" &&
        element.style.zIndex === "2147483647",
    );
    if (!overlay) {
      return;
    }
    observer.disconnect();
    const marker = document.createElement("div");
    marker.inert = true;
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;border:2px solid rgb(255,0,255);box-sizing:border-box;pointer-events:none";
    const follow = new MutationObserver(() => {
      if (!overlay.isConnected) {
        marker.remove();
        follow.disconnect();
      } else {
        marker.style.visibility = overlay.style.visibility;
      }
    });
    marker.style.visibility = overlay.style.visibility;
    document.documentElement.append(marker);
    follow.observe(overlay, { attributes: true, attributeFilter: ["style"] });
    follow.observe(document.documentElement, { childList: true });
  });
  observer.observe(document, { childList: true, subtree: true });
}

async function instrument(page: Page) {
  let armed = false;
  const context = page.context();
  const session = await context.newCDPSession(page);
  await session.send("Page.enable");
  const collectImages = process.env.L303_HOLD === "1";
  let loaderId = "";
  let imageResponses: Array<{
    path: string;
    status: number;
    diskCache: boolean;
    serviceWorker: boolean;
    encodedBytes: number;
  }> = [];
  if (collectImages) {
    await session.send("Network.enable");
    const mainFrame = (await session.send("Page.getFrameTree")).frameTree.frame.id;
    session.on("Network.requestWillBeSent", (event) => {
      if (event.type === "Document" && event.frameId === mainFrame) {
        loaderId = event.loaderId;
        imageResponses = [];
      }
    });
    session.on("Network.responseReceived", (event) => {
      if (
        event.type === "Image" &&
        event.loaderId === loaderId &&
        event.response.url.startsWith("http")
      ) {
        imageResponses.push({
          path: new URL(event.response.url).pathname,
          status: event.response.status,
          diskCache: Boolean(event.response.fromDiskCache),
          serviceWorker: Boolean(event.response.fromServiceWorker),
          encodedBytes: event.response.encodedDataLength,
        });
      }
    });
  }
  const originalNewSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (...args) => {
    const cdp = await originalNewSession(...args);
    if (args[0] !== page) {
      return cdp;
    }
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params) => {
      if (method === "Page.startScreencast") {
        armed = true;
      }
      return send(method, params);
    };
    return cdp;
  };
  let script: string | undefined;
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("L303_READY:")) {
      const index = Number(text.slice("L303_READY:".length));
      const work = (async () => {
        const before = await session.send("Page.captureScreenshot", { format: "png" });
        await writeFile(
          path.join(output, `${index}.snapshot.png`),
          Buffer.from(before.data, "base64"),
        );
        await page.evaluate(() => Reflect.get(window, "__l303Swap")());
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        const after = await session.send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(output, `${index}.live.png`), Buffer.from(after.data, "base64"));
        const regions = await page.evaluate(() =>
          Object.entries({
            sidebar: "aside.sidebar",
            header: ".chat-pane__header",
            transcript: ".chat-thread-viewport, .chat-thread",
            details: ".chat-details",
            composer: ".agent-chat__input, .agent-chat__disabled-banner--replacement",
            dashboard: "openclaw-board-view",
          }).flatMap(([name, selector]) => {
            const element = document.querySelector(selector);
            return element ? [{ name, ...element.getBoundingClientRect().toJSON() }] : [];
          }),
        );
        await writeFile(path.join(output, `${index}.regions.json`), JSON.stringify(regions));
      })().catch(async (error: unknown) => {
        await writeFile(
          path.join(output, `${index}.visual-error.json`),
          JSON.stringify({ error: String(error) }),
        );
      });
      pendingVisual.add(work);
      void work.finally(() => pendingVisual.delete(work));
    }
    if (text.startsWith("L303_RESULT:")) {
      const result = JSON.parse(text.slice("L303_RESULT:".length)) as { sequence: number };
      void writeFile(
        path.join(output, `${result.sequence}.result.json`),
        JSON.stringify(collectImages ? { ...result, imageResponses } : result, null, 2),
      );
    }
  });
  const prepare = async () => {
    if (!armed) {
      return;
    }
    armed = false;
    const url = page.url();
    if (new URL(url).hostname !== "127.0.0.1") {
      throw new Error("L303 only instruments owned loopback pages");
    }
    const snapshot = await page.evaluate<ReturnType<typeof captureDom>>(
      `(() => { const __name=(fn)=>fn; return (${captureDom.toString()})(); })()`,
    );
    if (!snapshot) {
      return;
    }
    const index = sequence++;
    const replay = !aa && (index % 4 === 1 || index % 4 === 2);
    const { markup, metrics, rect } = snapshot;
    const payload = JSON.stringify(snapshot);
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
          requiresDetails: snapshot.requiresDetails,
          requiresBoard: snapshot.requiresBoard,
          payloadRawBytes: Buffer.byteLength(payload),
          payloadGzipBytes: gzipSync(payload).byteLength,
          rawBytes: Buffer.byteLength(markup),
          gzipBytes: gzipSync(markup).byteLength,
        },
        null,
        2,
      ),
    );
    if (script) {
      await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script });
    }
    script = (
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `const __name=(fn)=>fn;(${replayDom.toString()})(${JSON.stringify({ snapshot, replay, sequence: index, url, hold: process.env.L303_HOLD === "1" })});${collectImages && replay ? `(${installSnapshotWitness.toString()})()` : ""}`,
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
  const close = browser.close.bind(browser);
  browser.close = async (...closeArgs) => {
    await Promise.all(pendingVisual);
    return close(...closeArgs);
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...contextArgs) => {
    const context = await newContext(...contextArgs);
    const closeContext = context.close.bind(context);
    context.close = async (...closeArgs) => {
      await Promise.all(pendingVisual);
      return closeContext(...closeArgs);
    };
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
