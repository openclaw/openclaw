import { Context } from "@a2ui/lit/ui";

function styleSheet(text) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text.join(""));
  return sheet;
}

const modalStyles = styleSheet`
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
  styleSheet`
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
  styleSheet`
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
  styleSheet`
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

export const openclawTheme = {
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

// The upstream catalog consumes the DOM context protocol; the theme is immutable.
export function provideTheme(host) {
  const listener = (event) => {
    if (event.context !== Context.themeContext) {
      return;
    }
    event.stopPropagation();
    event.callback(openclawTheme);
  };
  host.addEventListener("context-request", listener);
  return () => host.removeEventListener("context-request", listener);
}
