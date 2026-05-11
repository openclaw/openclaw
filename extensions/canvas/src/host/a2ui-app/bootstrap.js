import { v0_8 } from "@a2ui/lit";
import { ContextProvider } from "@lit/context";
import { themeContext } from "@openclaw/a2ui-theme-context";
import { html, css, LitElement, unsafeCSS } from "lit";
import "@a2ui/lit/ui";
import { repeat } from "lit/directives/repeat.js";

const modalStyles = css`
  dialog {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 24px;
    border: none;
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
  }

  dialog::backdrop {
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
  }
`;

const modalElement = customElements.get("a2ui-modal");
if (modalElement && Array.isArray(modalElement.styles)) {
  modalElement.styles = [...modalElement.styles, modalStyles];
}

const appendComponentStyles = (tagName, extraStyles) => {
  const component = customElements.get(tagName);
  if (!component) {
    return;
  }

  const current = component.styles;
  if (!current) {
    component.styles = [extraStyles];
    return;
  }

  component.styles = Array.isArray(current) ? [...current, extraStyles] : [current, extraStyles];
};

appendComponentStyles(
  "a2ui-row",
  css`
    @media (max-width: 860px) {
      section {
        flex-wrap: wrap;
        align-content: flex-start;
      }

      ::slotted(*) {
        flex: 1 1 100%;
        min-width: 100%;
        width: 100%;
        max-width: 100%;
      }
    }
  `,
);

appendComponentStyles(
  "a2ui-column",
  css`
    :host {
      min-width: 0;
    }

    section {
      min-width: 0;
    }
  `,
);

appendComponentStyles(
  "a2ui-card",
  css`
    :host {
      min-width: 0;
    }

    section {
      min-width: 0;
    }
  `,
);

const emptyClasses = () => ({});
const textHintStyles = () => ({ h1: {}, h2: {}, h3: {}, h4: {}, h5: {}, body: {}, caption: {} });

const isAndroid = /Android/i.test(globalThis.navigator?.userAgent ?? "");
const cardShadow = isAndroid ? "0 2px 10px rgba(0,0,0,.18)" : "0 10px 30px rgba(0,0,0,.35)";
const buttonShadow = isAndroid
  ? "0 2px 10px rgba(6, 182, 212, 0.14)"
  : "0 10px 25px rgba(6, 182, 212, 0.18)";
const statusShadow = isAndroid
  ? "0 2px 10px rgba(0, 0, 0, 0.18)"
  : "0 10px 24px rgba(0, 0, 0, 0.25)";
const statusBlur = isAndroid ? "10px" : "14px";

const postNativeMessage = (handler, payload) => {
  Reflect.apply(handler.postMessage, handler, [payload]);
};

const openclawTheme = {
  components: {
    AudioPlayer: emptyClasses(),
    Button: emptyClasses(),
    Card: emptyClasses(),
    Column: emptyClasses(),
    CheckBox: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    DateTimeInput: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Divider: emptyClasses(),
    Image: {
      all: emptyClasses(),
      icon: emptyClasses(),
      avatar: emptyClasses(),
      smallFeature: emptyClasses(),
      mediumFeature: emptyClasses(),
      largeFeature: emptyClasses(),
      header: emptyClasses(),
    },
    Icon: emptyClasses(),
    List: emptyClasses(),
    Modal: { backdrop: emptyClasses(), element: emptyClasses() },
    MultipleChoice: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Row: emptyClasses(),
    Slider: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Tabs: {
      container: emptyClasses(),
      element: emptyClasses(),
      controls: { all: emptyClasses(), selected: emptyClasses() },
    },
    Text: {
      all: emptyClasses(),
      h1: emptyClasses(),
      h2: emptyClasses(),
      h3: emptyClasses(),
      h4: emptyClasses(),
      h5: emptyClasses(),
      caption: emptyClasses(),
      body: emptyClasses(),
    },
    TextField: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Video: emptyClasses(),
  },
  elements: {
    a: emptyClasses(),
    audio: emptyClasses(),
    body: emptyClasses(),
    button: emptyClasses(),
    h1: emptyClasses(),
    h2: emptyClasses(),
    h3: emptyClasses(),
    h4: emptyClasses(),
    h5: emptyClasses(),
    iframe: emptyClasses(),
    input: emptyClasses(),
    p: emptyClasses(),
    pre: emptyClasses(),
    textarea: emptyClasses(),
    video: emptyClasses(),
  },
  markdown: {
    p: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    ul: [],
    ol: [],
    li: [],
    a: [],
    strong: [],
    em: [],
  },
  additionalStyles: {
    Card: {
      background: "linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03))",
      border: "1px solid rgba(255,255,255,.09)",
      borderRadius: "14px",
      padding: "14px",
      boxShadow: cardShadow,
    },
    Modal: {
      background: "rgba(12, 16, 24, 0.92)",
      border: "1px solid rgba(255,255,255,.12)",
      borderRadius: "16px",
      padding: "16px",
      boxShadow: "0 30px 80px rgba(0,0,0,.6)",
      width: "min(520px, calc(100vw - 48px))",
    },
    Column: { gap: "10px" },
    Row: { gap: "10px", alignItems: "center" },
    Divider: { opacity: "0.25" },
    Button: {
      background: "linear-gradient(135deg, #22c55e 0%, #06b6d4 100%)",
      border: "0",
      borderRadius: "12px",
      padding: "10px 14px",
      color: "#071016",
      fontWeight: "650",
      cursor: "pointer",
      boxShadow: buttonShadow,
    },
    Text: {
      ...textHintStyles(),
      h1: { fontSize: "20px", fontWeight: "750", margin: "0 0 6px 0" },
      h2: { fontSize: "16px", fontWeight: "700", margin: "0 0 6px 0" },
      body: { fontSize: "13px", lineHeight: "1.4" },
      caption: { opacity: "0.8" },
    },
    TextField: { display: "grid", gap: "6px" },
    Image: { borderRadius: "12px" },
  },
};

const text = (value, fallback) => {
  if (typeof value !== "string") {return fallback;}
  const trimmed = value.trim();
  return trimmed || fallback;
};

const safeArray = (value, fallback = []) => (Array.isArray(value) ? value : fallback);

const defaultDashboard = () => ({
  gatewayState: "connected",
  eyebrow: "Thomas Workbench",
  title: "Good. The desk is awake.",
  subtitle: "A living command surface for active work, connected devices, useful shortcuts, and the bits Thomas should keep close.",
  mood: "Ready",
  moodNote: "Connected enough to be helpful, sharp enough to be dangerous.",
  gatewayLabel: "Running",
  gatewayCaption: "Canvas is connected through the live gateway.",
  activeAgentName: "Main",
  activeAgentCaption: "Thomas is ready for the next useful thing.",
  talkLabel: "Standby",
  talkCaption: "Voice can step in once a conversation starts.",
  nextLabel: "Proactive queue",
  nextCaption: "Suggestions, cron output, and useful next moves land here.",
  plan: [
    { title: "Keep priorities visible", caption: "Current work, approvals, reminders, and handoff should live here.", status: "ready" },
    { title: "Turn chat into action", caption: "Use Canvas for previews, checklists, generated pages, and device actions.", status: "next" },
    { title: "Stay personal and fast", caption: "Sharp, useful, a little funny, and never generic on purpose.", status: "soon" },
  ],
  actions: [
    { kicker: "Setup", title: "Pair iPhone", caption: "Keep gateway connection details nearby." },
    { kicker: "Voice", title: "Check Talk", caption: "Review provider, key, voice, and latency state." },
    { kicker: "Work", title: "Open plan", caption: "Keep the active plan visible while Thomas works." },
    { kicker: "Files", title: "Preview output", caption: "Render generated pages, docs, and screenshots here." },
  ],
  devices: [
    { badge: "Mac", name: "Mac gateway", caption: "Local control center" },
    { badge: "iOS", name: "iPhone", caption: "Paired assistant mode" },
  ],
  memories: [
    { name: "Tone", caption: "Personal, direct, funny when it helps." },
    { name: "Preference", caption: "Fast voice first, cloud deluxe when available." },
    { name: "Focus", caption: "Make the next useful action obvious." },
  ],
  agents: [],
  notion: [
    { kicker: "Notion", title: "Connect a source", caption: "Add a Notion dashboard source so Thomas can pin important pages, projects, and reminders here." },
  ],
  cronRuns: [
    { kicker: "Cron", title: "No recent run yet", caption: "Completed automation runs will appear here with compact summaries." },
  ],
  attention: [
    { kicker: "Ready", title: "Choose the next useful thing", caption: "Thomas is watching for follow-ups, failures, approvals, and handoffs." },
  ],
  today: [
    { kicker: "Now", title: "Workspace awake", caption: "Gateway, Canvas, and assistant surface are ready." },
  ],
  seriousSuggestion: {
    kicker: "Serious suggestion",
    title: "Draft a useful BlueBubbles message",
    caption: "Thomas can summarize a news article, turn it into a short personal message, and queue it for approval before sending.",
    actionLabel: "Prepare draft",
  },
  funSuggestion: {
    kicker: "Fun suggestion",
    title: "Teach Thomas image generation",
    caption: "Add a playful image mode with prompt templates, style memory, and Canvas previews before anything gets saved or sent.",
    actionLabel: "Explore image mode",
  },
});

const normalizeDashboard = (state) => {
  const base = defaultDashboard();
  const merged = { ...base, ...(state || {}) };
  merged.plan = safeArray(state?.plan, base.plan);
  merged.actions = safeArray(state?.actions, base.actions);
  merged.devices = safeArray(state?.devices, base.devices);
  merged.memories = safeArray(state?.memories || state?.memory, base.memories);
  merged.agents = safeArray(state?.agents, base.agents);
  merged.notion = safeArray(state?.notion, base.notion);
  merged.cronRuns = safeArray(state?.cronRuns, base.cronRuns);
  merged.attention = safeArray(state?.attention, base.attention);
  merged.today = safeArray(state?.today, base.today);
  merged.seriousSuggestion = state?.seriousSuggestion || base.seriousSuggestion;
  merged.funSuggestion = state?.funSuggestion || base.funSuggestion;
  return merged;
};

class OpenClawA2UIHost extends LitElement {
  static properties = {
    surfaces: { state: true },
    pendingAction: { state: true },
    toast: { state: true },
    nowLabel: { state: true },
    dashboard: { state: true },
  };

  #processor = v0_8.Data.createSignalA2uiMessageProcessor();
  themeProvider = new ContextProvider(this, {
    context: themeContext,
    initialValue: openclawTheme,
  });

  surfaces = [];
  pendingAction = null;
  toast = null;
  nowLabel = "";
  dashboard = defaultDashboard();
  #statusListener = null;
  #dashboardClock = null;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      position: relative;
      box-sizing: border-box;
      padding: var(--openclaw-a2ui-inset-top, 0px) var(--openclaw-a2ui-inset-right, 0px)
        var(--openclaw-a2ui-inset-bottom, 0px) var(--openclaw-a2ui-inset-left, 0px);
    }

    #surfaces {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      height: 100%;
      overflow: auto;
      padding-bottom: var(--openclaw-a2ui-scroll-pad-bottom, 0px);
    }

    .status {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--openclaw-a2ui-status-top, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font:
        13px/1.2 system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Roboto",
        sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${unsafeCSS(statusBlur)});
      -webkit-backdrop-filter: blur(${unsafeCSS(statusBlur)});
      box-shadow: ${unsafeCSS(statusShadow)};
      z-index: 5;
    }

    .toast {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: var(--openclaw-a2ui-toast-bottom, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font:
        13px/1.2 system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Roboto",
        sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${unsafeCSS(statusBlur)});
      -webkit-backdrop-filter: blur(${unsafeCSS(statusBlur)});
      box-shadow: ${unsafeCSS(statusShadow)};
      z-index: 5;
    }

    .toast.error {
      border-color: rgba(255, 109, 109, 0.35);
      color: rgba(255, 223, 223, 0.98);
    }

    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      align-content: start;
      overflow: auto;
      padding: max(18px, var(--openclaw-a2ui-empty-top, 18px)) 24px 24px;
      pointer-events: auto;
      isolation: isolate;
      background:
        linear-gradient(135deg, rgba(37, 99, 235, 0.2) 0%, rgba(8, 11, 16, 0) 36%),
        linear-gradient(315deg, rgba(20, 184, 166, 0.16) 0%, rgba(8, 11, 16, 0) 32%),
        linear-gradient(180deg, #10141b 0%, #070a0f 100%);
    }

    .empty::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      background:
        linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
      background-size: 42px 42px;
      mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.75), transparent 84%);
    }

    .workbench {
      position: relative;
      z-index: 1;
      width: min(1120px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.75fr);
      gap: 14px;
      color: rgba(249, 250, 251, 0.96);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Roboto", sans-serif;
    }

    .hero,
    .panel {
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      background: linear-gradient(145deg, rgba(21, 26, 34, 0.9), rgba(12, 15, 21, 0.74));
      box-shadow: 0 22px 70px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }

    .hero {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 0.32fr);
      gap: 16px;
      padding: 18px;
    }

    .eyebrow,
    .label,
    .meta {
      color: rgba(218, 225, 232, 0.66);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 9px;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #67d391;
      box-shadow: 0 0 18px rgba(103, 211, 145, 0.7);
    }

    .empty-title {
      margin: 10px 0 0;
      font-size: 38px;
      line-height: 1.04;
      font-weight: 820;
      letter-spacing: 0;
    }

    .subtitle {
      margin: 10px 0 0;
      max-width: 740px;
      color: rgba(218, 225, 232, 0.76);
      font-size: 15px;
      line-height: 1.5;
    }

    .mood {
      display: grid;
      align-content: space-between;
      min-height: 132px;
      padding: 14px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(103, 211, 145, 0.14), rgba(130, 184, 255, 0.09));
    }

    .mood-value {
      margin-top: 8px;
      font-size: 22px;
      font-weight: 820;
    }

    .mood-note,
    .caption {
      color: rgba(218, 225, 232, 0.74);
      font-size: 12px;
      line-height: 1.35;
    }

    .main,
    .rail {
      display: grid;
      gap: 14px;
      align-content: start;
    }

    .status-grid,
    .actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .stat,
    .task,
    .action,
    .memory,
    .signal {
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
    }

    .stat {
      min-height: 92px;
      padding: 13px;
    }

    .value {
      margin-top: 8px;
      font-size: 18px;
      font-weight: 820;
      overflow-wrap: anywhere;
    }

    .panel {
      padding: 15px;
    }

    .focus-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 0.34fr);
      gap: 14px;
    }

    .focus-title {
      margin: 0;
      font-size: 22px;
      line-height: 1.12;
      font-weight: 820;
    }

    .focus-copy {
      margin: 8px 0 0;
      color: rgba(218, 225, 232, 0.76);
      font-size: 13px;
      line-height: 1.45;
    }

    .pulse-grid {
      display: grid;
      gap: 8px;
    }

    .signal {
      padding: 10px;
    }

    .signal strong {
      display: block;
      margin-top: 4px;
      font-size: 13px;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .panel-title {
      font-size: 15px;
      font-weight: 820;
    }

    .tasks,
    .memory-list {
      display: grid;
      gap: 8px;
    }

    .task {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 10px;
      padding: 11px;
    }

    .mark {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #67d391;
      font-size: 12px;
      font-weight: 820;
    }

    .item-title {
      font-size: 14px;
      font-weight: 780;
    }

    .action,
    .memory {
      padding: 11px;
    }

    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .line-list,
    .suggestion-grid {
      display: grid;
      gap: 8px;
    }

    .line-card,
    .suggestion {
      padding: 11px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
    }

    .line-card strong,
    .suggestion strong {
      display: block;
      margin-top: 5px;
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    .suggestion {
      min-height: 124px;
      display: grid;
      align-content: start;
      gap: 6px;
    }

    .suggestion.work {
      border-color: rgba(130, 184, 255, 0.28);
      background: linear-gradient(135deg, rgba(130, 184, 255, 0.13), rgba(255, 255, 255, 0.035));
    }

    .suggestion.fun {
      border-color: rgba(255, 194, 103, 0.28);
      background: linear-gradient(135deg, rgba(255, 194, 103, 0.12), rgba(103, 211, 145, 0.07));
    }

    .suggestion-action {
      width: fit-content;
      margin-top: 3px;
      padding: 5px 8px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      color: rgba(249, 250, 251, 0.86);
      font-size: 11px;
      font-weight: 780;
    }

    .action-kicker {
      color: #82b8ff;
      font-size: 11px;
      font-weight: 820;
    }

    @media (max-width: 860px) {
      .empty {
        padding: max(12px, var(--openclaw-a2ui-empty-top, 12px)) 10px 18px;
      }

      .workbench,
      .hero,
      .focus-panel {
        grid-template-columns: 1fr;
      }

      .empty-title {
        font-size: 28px;
      }
    }

    @media (max-width: 560px) {
      .status-grid,
      .actions,
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
    }

    .spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.25);
      border-top-color: rgba(255, 255, 255, 0.92);
      animation: spin 0.75s linear infinite;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.#updateDashboardClock();
    this.#dashboardClock = globalThis.setInterval?.(() => {
      this.#updateDashboardClock();
    }, 30_000) ?? null;
    const api = {
      applyMessages: (messages) => this.applyMessages(messages),
      renderHome: (state) => this.renderHome(state),
      reset: () => this.reset(),
      getSurfaces: () => Array.from(this.#processor.getSurfaces().keys()),
    };
    globalThis.openclawA2UI = api;
    globalThis.__openclaw = {
      ...(globalThis.__openclaw || {}),
      renderHome: (state) => this.renderHome(state),
    };
    this.addEventListener("a2uiaction", (evt) => this.#handleA2UIAction(evt));
    this.#statusListener = (evt) => this.#handleActionStatus(evt);
    for (const eventName of ["openclaw:a2ui-action-status"]) {
      globalThis.addEventListener(eventName, this.#statusListener);
    }
    this.#syncSurfaces();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.#dashboardClock) {
      globalThis.clearInterval?.(this.#dashboardClock);
      this.#dashboardClock = null;
    }
    if (this.#statusListener) {
      for (const eventName of ["openclaw:a2ui-action-status"]) {
        globalThis.removeEventListener(eventName, this.#statusListener);
      }
      this.#statusListener = null;
    }
  }

  #makeActionId() {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `a2ui_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
  }

  #updateDashboardClock() {
    try {
      this.nowLabel = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date());
    } catch {
      this.nowLabel = new Date().toLocaleTimeString();
    }
  }

  #setToast(text, kind = "ok", timeoutMs = 1400) {
    const toast = { text, kind, expiresAt: Date.now() + timeoutMs };
    this.toast = toast;
    this.requestUpdate();
    setTimeout(() => {
      if (this.toast === toast) {
        this.toast = null;
        this.requestUpdate();
      }
    }, timeoutMs + 30);
  }

  #handleActionStatus(evt) {
    const detail = evt?.detail ?? null;
    if (!detail || typeof detail.id !== "string") {
      return;
    }
    if (!this.pendingAction || this.pendingAction.id !== detail.id) {
      return;
    }

    if (detail.ok) {
      this.pendingAction = { ...this.pendingAction, phase: "sent", sentAt: Date.now() };
    } else {
      const msg = typeof detail.error === "string" && detail.error ? detail.error : "send failed";
      this.pendingAction = { ...this.pendingAction, phase: "error", error: msg };
      this.#setToast(`Failed: ${msg}`, "error", 4500);
    }
    this.requestUpdate();
  }

  #handleA2UIAction(evt) {
    const payload = evt?.detail ?? evt?.payload ?? null;
    if (!payload || payload.eventType !== "a2ui.action") {
      return;
    }

    const action = payload.action;
    const name = action?.name;
    if (!name) {
      return;
    }

    const sourceComponentId = payload.sourceComponentId ?? "";
    const surfaces = this.#processor.getSurfaces();

    let surfaceId = null;
    let sourceNode = null;
    for (const [sid, surface] of surfaces.entries()) {
      const node = surface?.components?.get?.(sourceComponentId) ?? null;
      if (node) {
        surfaceId = sid;
        sourceNode = node;
        break;
      }
    }

    const context = {};
    const ctxItems = Array.isArray(action?.context) ? action.context : [];
    for (const item of ctxItems) {
      const key = item?.key;
      const value = item?.value ?? null;
      if (!key || !value) {
        continue;
      }

      if (typeof value.path === "string") {
        const resolved = sourceNode
          ? this.#processor.getData(sourceNode, value.path, surfaceId ?? undefined)
          : null;
        context[key] = resolved;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, "literalString")) {
        context[key] = value.literalString ?? "";
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, "literalNumber")) {
        context[key] = value.literalNumber ?? 0;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, "literalBoolean")) {
        context[key] = value.literalBoolean ?? false;
        continue;
      }
    }

    const actionId = this.#makeActionId();
    this.pendingAction = { id: actionId, name, phase: "sending", startedAt: Date.now() };
    this.requestUpdate();

    const userAction = {
      id: actionId,
      name,
      surfaceId: surfaceId ?? "main",
      sourceComponentId,
      timestamp: new Date().toISOString(),
      ...(Object.keys(context).length ? { context } : {}),
    };

    globalThis.__openclawLastA2UIAction = userAction;

    const handler =
      globalThis.webkit?.messageHandlers?.openclawCanvasA2UIAction ??
      globalThis.openclawCanvasA2UIAction;
    if (handler?.postMessage) {
      try {
        // WebKit message handlers support structured objects; Android's JS interface expects strings.
        if (handler === globalThis.openclawCanvasA2UIAction) {
          postNativeMessage(handler, JSON.stringify({ userAction }));
        } else {
          postNativeMessage(handler, { userAction });
        }
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.pendingAction = {
          id: actionId,
          name,
          phase: "error",
          startedAt: Date.now(),
          error: msg,
        };
        this.#setToast(`Failed: ${msg}`, "error", 4500);
      }
    } else {
      this.pendingAction = {
        id: actionId,
        name,
        phase: "error",
        startedAt: Date.now(),
        error: "missing native bridge",
      };
      this.#setToast("Failed: missing native bridge", "error", 4500);
    }
  }

  applyMessages(messages) {
    if (!Array.isArray(messages)) {
      throw new Error("A2UI: expected messages array");
    }
    this.#processor.processMessages(messages);
    this.#syncSurfaces();
    if (this.pendingAction?.phase === "sent") {
      this.#setToast(`Updated: ${this.pendingAction.name}`, "ok", 1100);
      this.pendingAction = null;
    }
    this.requestUpdate();
    return { ok: true, surfaces: this.surfaces.map(([id]) => id) };
  }

  reset() {
    this.#processor.clearSurfaces();
    this.#syncSurfaces();
    this.pendingAction = null;
    this.requestUpdate();
    return { ok: true };
  }

  renderHome(state) {
    this.dashboard = normalizeDashboard(state);
    this.requestUpdate();
    return { ok: true };
  }

  #syncSurfaces() {
    this.surfaces = Array.from(this.#processor.getSurfaces().entries());
  }

  #renderLineList(items, emptyText = "Nothing reported yet.") {
    if (!items.length) {
      return html`<div class="line-card"><div class="caption">${emptyText}</div></div>`;
    }
    return html`${items.map((item) => html`
      <article class="line-card">
        <div class="action-kicker">${text(item.kicker || item.badge || item.status, "Signal")}</div>
        <strong>${text(item.title || item.name, "Untitled")}</strong>
        <div class="caption">${text(item.caption || item.summary, "Ready")}</div>
      </article>
    `)}`;
  }

  #renderTaskList(items) {
    return html`${items.map((item, index) => html`
      <div class="task">
        <div class="mark">${item.status === "done" ? "ok" : String(index + 1)}</div>
        <div>
          <div class="item-title">${text(item.title, "Untitled step")}</div>
          <div class="caption">${text(item.caption, "No detail yet")}</div>
        </div>
      </div>
    `)}`;
  }

  #renderActionGrid(items) {
    return html`${items.map((item) => html`
      <div class="action">
        <div class="action-kicker">${text(item.kicker, "Action")}</div>
        <div class="item-title">${text(item.title, "Open")}</div>
        <div class="caption">${text(item.caption, "Ready")}</div>
      </div>
    `)}`;
  }

  #renderMemoryList(items) {
    return html`${items.map((item) => html`
      <div class="memory">
        <div class="item-title">${text(item.name || item.title, "Memory")}</div>
        <div class="caption">${text(item.caption, "No detail yet")}</div>
      </div>
    `)}`;
  }

  #renderSuggestion(item, kind) {
    return html`<article class="suggestion ${kind}">
      <div class="action-kicker">${text(item?.kicker, kind === "work" ? "Serious suggestion" : "Fun suggestion")}</div>
      <strong>${text(item?.title, "Try something useful")}</strong>
      <div class="caption">${text(item?.caption, "Thomas can prepare this when you ask.")}</div>
      <div class="suggestion-action">${text(item?.actionLabel, "Ask Thomas")}</div>
    </article>`;
  }

  render() {
    if (this.surfaces.length === 0) {
      const d = normalizeDashboard(this.dashboard);
      return html`<div class="empty">
        <section class="workbench" aria-label="Thomas Workbench">
          <header class="hero">
            <div>
              <div class="eyebrow"><span class="dot"></span><span>${text(d.eyebrow, "Thomas Workbench")}</span></div>
              <h1 class="empty-title">${text(d.title, "Good. The desk is awake.")}</h1>
              <p class="subtitle">${text(d.subtitle, "A living command surface for active work, connected devices, useful shortcuts, and the bits Thomas should keep close.")}</p>
            </div>
            <aside class="mood">
              <div>
                <div class="label">Current posture</div>
                <div class="mood-value">${text(d.mood, "Ready")}</div>
              </div>
              <div class="mood-note">${text(d.moodNote, "Connected enough to be helpful, sharp enough to be dangerous.")} ${text(d.updatedAtLabel, this.nowLabel)}</div>
            </aside>
          </header>

          <main class="main">
            <section class="panel focus-panel">
              <div>
                <div class="label">Now</div>
                <h2 class="focus-title">${text(d.focusTitle, "Ask, inspect, hand off, or let Thomas keep moving.")}</h2>
                <p class="focus-copy">${text(d.focusCopy, "This dashboard is the shared Mac and iPhone home base: status first, action close by, and enough personality to feel like Thomas is actually awake.")}</p>
              </div>
              <div class="pulse-grid" aria-label="System pulse">
                ${this.#renderLineList(d.today, "No current signals.")}
              </div>
            </section>

            <section class="status-grid" aria-label="Status">
              <div class="stat">
                <div class="label">Gateway</div>
                <div class="value">${text(d.gatewayLabel, "Gateway")}</div>
                <div class="caption">${text(d.gatewayCaption, "Waiting for live status.")}</div>
              </div>
              <div class="stat">
                <div class="label">Active agent</div>
                <div class="value">${text(d.activeAgentName, "Main")}</div>
                <div class="caption">${text(d.activeAgentCaption, "Thomas is ready for the next useful thing.")}</div>
              </div>
              <div class="stat">
                <div class="label">Talk</div>
                <div class="value">${text(d.talkLabel, "Standby")}</div>
                <div class="caption">${text(d.talkCaption, "Voice can step in once a conversation starts.")}</div>
              </div>
              <div class="stat">
                <div class="label">Next</div>
                <div class="value">${text(d.nextLabel, "Proactive queue")}</div>
                <div class="caption">${text(d.nextCaption, "Surface reminders, approvals, and next steps here.")}</div>
              </div>
            </section>

            <section class="dashboard-grid">
              <section class="panel">
                <div class="panel-header">
                  <div class="panel-title">Notion Focus</div>
                  <div class="meta">${d.notion.length}</div>
                </div>
                <div class="line-list">${this.#renderLineList(d.notion, "No Notion cards loaded yet.")}</div>
              </section>
              <section class="panel">
                <div class="panel-header">
                  <div class="panel-title">Recent cron runs</div>
                  <div class="meta">${d.cronRuns.length}</div>
                </div>
                <div class="line-list">${this.#renderLineList(d.cronRuns, "No recent automation runs yet.")}</div>
              </section>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div class="panel-title">Proactive suggestions</div>
                <div class="meta">2 ideas</div>
              </div>
              <div class="suggestion-grid">
                ${this.#renderSuggestion(d.seriousSuggestion, "work")}
                ${this.#renderSuggestion(d.funSuggestion, "fun")}
              </div>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div class="panel-title">Current plan</div>
                <div class="meta">${d.plan.length} steps</div>
              </div>
              <div class="tasks">
                ${this.#renderTaskList(d.plan)}
              </div>
            </section>
          </main>

          <aside class="rail">
            <section class="panel">
              <div class="panel-header">
                <div class="panel-title">At your fingertips</div>
                <div class="meta">${d.actions.length}</div>
              </div>
              <div class="actions">
                ${this.#renderActionGrid(d.actions)}
              </div>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div class="panel-title">Attention</div>
                <div class="meta">${d.attention.length}</div>
              </div>
              <div class="line-list">
                ${this.#renderLineList(d.attention, "No urgent attention items.")}
              </div>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div class="panel-title">Memory and context</div>
                <div class="meta">${d.memories.length}</div>
              </div>
              <div class="memory-list">
                ${this.#renderMemoryList(d.memories)}
              </div>
            </section>
          </aside>
        </section>
      </div>`;
    }

    const statusText =
      this.pendingAction?.phase === "sent"
        ? `Working: ${this.pendingAction.name}`
        : this.pendingAction?.phase === "sending"
          ? `Sending: ${this.pendingAction.name}`
          : this.pendingAction?.phase === "error"
            ? `Failed: ${this.pendingAction.name}`
            : "";

    return html` ${this.pendingAction && this.pendingAction.phase !== "error"
        ? html`<div class="status">
            <div class="spinner"></div>
            <div>${statusText}</div>
          </div>`
        : ""}
      ${this.toast
        ? html`<div class="toast ${this.toast.kind === "error" ? "error" : ""}">
            ${this.toast.text}
          </div>`
        : ""}
      <section id="surfaces">
        ${repeat(
          this.surfaces,
          ([surfaceId]) => surfaceId,
          ([surfaceId, surface]) => html`<a2ui-surface
            .surfaceId=${surfaceId}
            .surface=${surface}
            .processor=${this.#processor}
          ></a2ui-surface>`,
        )}
      </section>`;
  }
}

if (!customElements.get("openclaw-a2ui-host")) {
  customElements.define("openclaw-a2ui-host", OpenClawA2UIHost);
}
