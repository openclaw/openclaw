import { FileDiff, preloadHighlighter } from "@pierre/diffs";
import type {
  FileContents,
  FileDiffMetadata,
  FileDiffOptions,
  SupportedLanguages,
} from "@pierre/diffs";
import type { DiffViewerPayload, DiffLayout, DiffTheme } from "./types.js";

type ViewerState = {
  theme: DiffTheme;
  layout: DiffLayout;
  backgroundEnabled: boolean;
  wrapEnabled: boolean;
};

type DiffController = {
  payload: DiffViewerPayload;
  diff: FileDiff;
};

const controllers: DiffController[] = [];

const viewerState: ViewerState = {
  theme: "dark",
  layout: "unified",
  backgroundEnabled: true,
  wrapEnabled: true,
};

function parsePayload(element: HTMLScriptElement): DiffViewerPayload {
  const raw = element.textContent?.trim();
  if (!raw) {
    throw new Error("Diff payload was empty.");
  }
  return JSON.parse(raw) as DiffViewerPayload;
}

function getCards(): Array<{ host: HTMLElement; payload: DiffViewerPayload }> {
  return [...document.querySelectorAll<HTMLElement>(".oc-diff-card")].flatMap((card) => {
    const host = card.querySelector<HTMLElement>("[data-openclaw-diff-host]");
    const payloadNode = card.querySelector<HTMLScriptElement>("[data-openclaw-diff-payload]");
    if (!host || !payloadNode) {
      return [];
    }
    return [{ host, payload: parsePayload(payloadNode) }];
  });
}

function ensureShadowRoot(host: HTMLElement): void {
  if (host.shadowRoot) {
    return;
  }
  const template = host.querySelector<HTMLTemplateElement>(
    ":scope > template[shadowrootmode='open']",
  );
  if (!template) {
    return;
  }
  const shadowRoot = host.attachShadow({ mode: "open" });
  shadowRoot.append(template.content.cloneNode(true));
  template.remove();
}

function getHydrateProps(payload: DiffViewerPayload): {
  fileDiff?: FileDiffMetadata;
  oldFile?: FileContents;
  newFile?: FileContents;
} {
  if (payload.fileDiff) {
    return { fileDiff: payload.fileDiff };
  }
  return {
    oldFile: payload.oldFile,
    newFile: payload.newFile,
  };
}

function createToolbarButton(params: {
  title: string;
  active: boolean;
  iconMarkup: string;
  onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "oc-diff-toolbar-button";
  button.dataset.active = String(params.active);
  button.title = params.title;
  button.setAttribute("aria-label", params.title);
  button.innerHTML = params.iconMarkup;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    params.onClick();
  });
  return button;
}

function splitIcon(): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0"></path>
    <path fill="currentColor" opacity="0.35" d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1"></path>
  </svg>`;
}

function unifiedIcon(): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10" clip-rule="evenodd"></path>
    <path fill="currentColor" fill-rule="evenodd" opacity="0.4" d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" clip-rule="evenodd"></path>
  </svg>`;
}

function wrapIcon(active: boolean): string {
  if (active) {
    return `<svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" opacity="0.88" d="M2 4.25h8.25a2.75 2.75 0 1 1 0 5.5H7.5a.75.75 0 0 0 0 1.5h3.1l-1.07 1.06a.75.75 0 1 0 1.06 1.06l2.35-2.34a.75.75 0 0 0 0-1.06l-2.35-2.34a.75.75 0 1 0-1.06 1.06l1.07 1.06H10.25a1.25 1.25 0 1 0 0-2.5H2z"></path>
      <rect x="2" y="11.75" width="4.75" height="1.5" rx=".75" fill="currentColor" opacity="0.55"></rect>
    </svg>`;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="4" width="12" height="1.5" rx=".75" fill="currentColor"></rect>
    <rect x="2" y="7.25" width="12" height="1.5" rx=".75" fill="currentColor" opacity="0.82"></rect>
    <rect x="2" y="10.5" width="12" height="1.5" rx=".75" fill="currentColor" opacity="0.64"></rect>
  </svg>`;
}

function backgroundIcon(active: boolean): string {
  if (active) {
    return `<svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" opacity="0.4" d="M0 2.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.25"></path>
      <path fill="currentColor" fill-rule="evenodd" d="M15 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2.5 9a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0-2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1z" clip-rule="evenodd"></path>
      <path fill="currentColor" opacity="0.4" d="M0 14.75A.75.75 0 0 1 .75 14h5.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75"></path>
    </svg>`;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" opacity="0.22" d="M0 2.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.25"></path>
    <path fill="currentColor" opacity="0.22" fill-rule="evenodd" d="M15 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2.5 9a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0-2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1z" clip-rule="evenodd"></path>
    <path fill="currentColor" opacity="0.22" d="M0 14.75A.75.75 0 0 1 .75 14h5.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75"></path>
    <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"></path>
  </svg>`;
}

function themeIcon(theme: DiffTheme): string {
  if (theme === "dark") {
    return `<svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M10.794 3.647a.217.217 0 0 1 .412 0l.387 1.162c.173.518.58.923 1.097 1.096l1.162.388a.217.217 0 0 1 0 .412l-1.162.386a1.73 1.73 0 0 0-1.097 1.097l-.387 1.162a.217.217 0 0 1-.412 0l-.387-1.162A1.74 1.74 0 0 0 9.31 7.092l-1.162-.386a.217.217 0 0 1 0-.412l1.162-.388a1.73 1.73 0 0 0 1.097-1.096zM13.863.598a.144.144 0 0 1 .221-.071.14.14 0 0 1 .053.07l.258.775c.115.345.386.616.732.731l.774.258a.145.145 0 0 1 0 .274l-.774.259a1.16 1.16 0 0 0-.732.732l-.258.773a.145.145 0 0 1-.274 0l-.258-.773a1.16 1.16 0 0 0-.732-.732l-.774-.259a.145.145 0 0 1 0-.273l.774-.259c.346-.115.617-.386.732-.732z"></path>
      <path fill="currentColor" d="M6.25 1.742a.67.67 0 0 1 .07.75 6.3 6.3 0 0 0-.768 3.028c0 2.746 1.746 5.084 4.193 5.979H1.774A7.2 7.2 0 0 1 1 8.245c0-3.013 1.85-5.598 4.484-6.694a.66.66 0 0 1 .766.19M.75 12.499a.75.75 0 0 0 0 1.5h14.5a.75.75 0 0 0 0-1.5z"></path>
    </svg>`;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M6.856.764a.75.75 0 0 1 .094 1.035A5.75 5.75 0 0 0 13.81 10.95a.75.75 0 1 1 1.13.99A7.251 7.251 0 1 1 6.762.858a.75.75 0 0 1 .094-.094"></path>
  </svg>`;
}

function createToolbar(): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "oc-diff-toolbar";

  toolbar.append(
    createToolbarButton({
      title: viewerState.layout === "unified" ? "Switch to split diff" : "Switch to unified diff",
      active: viewerState.layout === "split",
      iconMarkup: viewerState.layout === "split" ? splitIcon() : unifiedIcon(),
      onClick: () => {
        viewerState.layout = viewerState.layout === "unified" ? "split" : "unified";
        syncAllControllers();
      },
    }),
  );

  toolbar.append(
    createToolbarButton({
      title: viewerState.wrapEnabled ? "Disable word wrap" : "Enable word wrap",
      active: viewerState.wrapEnabled,
      iconMarkup: wrapIcon(viewerState.wrapEnabled),
      onClick: () => {
        viewerState.wrapEnabled = !viewerState.wrapEnabled;
        syncAllControllers();
      },
    }),
  );

  toolbar.append(
    createToolbarButton({
      title: viewerState.backgroundEnabled
        ? "Hide background highlights"
        : "Show background highlights",
      active: viewerState.backgroundEnabled,
      iconMarkup: backgroundIcon(viewerState.backgroundEnabled),
      onClick: () => {
        viewerState.backgroundEnabled = !viewerState.backgroundEnabled;
        syncAllControllers();
      },
    }),
  );

  toolbar.append(
    createToolbarButton({
      title: viewerState.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      active: viewerState.theme === "dark",
      iconMarkup: themeIcon(viewerState.theme),
      onClick: () => {
        viewerState.theme = viewerState.theme === "dark" ? "light" : "dark";
        syncAllControllers();
      },
    }),
  );

  return toolbar;
}

function createRenderOptions(payload: DiffViewerPayload): FileDiffOptions<undefined> {
  return {
    theme: payload.options.theme,
    themeType: viewerState.theme,
    diffStyle: viewerState.layout,
    expandUnchanged: payload.options.expandUnchanged,
    overflow: viewerState.wrapEnabled ? "wrap" : "scroll",
    disableBackground: !viewerState.backgroundEnabled,
    unsafeCSS: payload.options.unsafeCSS,
    renderHeaderMetadata: () => createToolbar(),
  };
}

function syncDocumentTheme(): void {
  document.body.dataset.theme = viewerState.theme;
}

function applyState(controller: DiffController): void {
  controller.diff.setOptions(createRenderOptions(controller.payload));
  controller.diff.rerender();
}

function syncAllControllers(): void {
  syncDocumentTheme();
  for (const controller of controllers) {
    applyState(controller);
  }
}

async function hydrateViewer(): Promise<void> {
  const cards = getCards();
  const langs = new Set<SupportedLanguages>();
  const firstPayload = cards[0]?.payload;

  if (firstPayload) {
    viewerState.theme = firstPayload.options.themeType;
    viewerState.layout = firstPayload.options.diffStyle;
    viewerState.wrapEnabled = firstPayload.options.overflow === "wrap";
  }

  for (const { payload } of cards) {
    for (const lang of payload.langs) {
      langs.add(lang);
    }
  }

  await preloadHighlighter({
    themes: ["pierre-light", "pierre-dark"],
    langs: langs.size > 0 ? [...langs] : ["text"],
  });

  syncDocumentTheme();

  for (const { host, payload } of cards) {
    ensureShadowRoot(host);
    const diff = new FileDiff(createRenderOptions(payload));
    diff.hydrate({
      fileContainer: host,
      prerenderedHTML: payload.prerenderedHTML,
      ...getHydrateProps(payload),
    });
    const controller = { payload, diff };
    controllers.push(controller);
    applyState(controller);
  }
}

async function main(): Promise<void> {
  try {
    await hydrateViewer();
    document.documentElement.dataset.openclawDiffsReady = "true";
  } catch (error) {
    document.documentElement.dataset.openclawDiffsError = "true";
    console.error("Failed to hydrate diff viewer", error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void main();
  });
} else {
  void main();
}
