import { html, nothing, render } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import type { ControlUiComponentHandle, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { workboardHost } from "../host.ts";

type Components = ControlUiHost["components"];
type DialogProps = Parameters<Components["mountDialog"]>[1];
type PickerProps = Parameters<Components["mountAgentPicker"]>[1];
type AvatarProps = Parameters<Components["mountAgentAvatar"]>[1];
type SelectPickerProps = Parameters<Components["mountSelectPicker"]>[1];
type AppearancePickerProps = Parameters<Components["mountAppearancePicker"]>[1];
type AppearanceGlyphProps = Parameters<Components["mountAppearanceGlyph"]>[1];
type SessionSummaryProps = Parameters<Components["mountSessionSummary"]>[1];
function createHostComponent<Props extends object>(
  mount: (container: HTMLElement, props: Props) => ControlUiComponentHandle<Props>,
) {
  return directive(
    class extends AsyncDirective {
      private part?: ElementPart;
      private props?: Props;
      private handle?: ControlUiComponentHandle<Props>;

      render(_props: Props) {
        return nothing;
      }

      override update(part: ElementPart, [props]: [Props]) {
        this.part = part;
        this.props = props;
        if (this.handle) {
          this.handle.update(props);
        } else {
          // SAFETY: These private directives mount only into the div containers below.
          this.handle = mount(part.element as HTMLElement, props);
        }
        return nothing;
      }

      protected override disconnected() {
        this.handle?.dispose();
        this.handle = undefined;
      }

      protected override reconnected() {
        if (this.part && this.props) {
          this.update(this.part, [this.props]);
        }
      }
    },
  );
}

const mountDialog = createHostComponent(
  (container, initial: Omit<DialogProps, "content"> & { content: unknown }) => {
    const content = document.createElement("div");
    content.style.display = "contents";
    const prepare = (props: typeof initial) => {
      // The plugin owns this Lit root; the host owns only the dialog that contains it.
      render(props.content, content);
      return { ...props, content };
    };
    try {
      const handle = workboardHost().components.mountDialog(container, prepare(initial));
      return {
        update: (props) => handle.update(prepare(props)),
        dispose() {
          handle.dispose();
          render(nothing, content);
        },
      };
    } catch (error) {
      // A failed host mount can still leave nested plugin components in this Lit root.
      render(nothing, content);
      throw error;
    }
  },
);
const mountAgentPicker = createHostComponent((container, props: PickerProps) =>
  workboardHost().components.mountAgentPicker(container, props),
);
const mountAgentAvatar = createHostComponent((container, props: AvatarProps) =>
  workboardHost().components.mountAgentAvatar(container, props),
);
const mountSelectPicker = createHostComponent((container, props: SelectPickerProps) =>
  workboardHost().components.mountSelectPicker(container, props),
);
const mountAppearancePicker = createHostComponent((container, props: AppearancePickerProps) =>
  workboardHost().components.mountAppearancePicker(container, props),
);
const mountAppearanceGlyph = createHostComponent((container, props: AppearanceGlyphProps) =>
  workboardHost().components.mountAppearanceGlyph(container, props),
);
const mountSessionSummary = createHostComponent((container, props: SessionSummaryProps) =>
  workboardHost().components.mountSessionSummary(container, props),
);

export function renderDialog(props: Omit<DialogProps, "content">, content: unknown) {
  return html`<div style="display: contents" ${mountDialog({ ...props, content })}></div>`;
}

export function renderAgentPicker(props: PickerProps, className = "") {
  return html`<div class=${className} ${mountAgentPicker(props)}></div>`;
}

export function renderAgentAvatar(props: AvatarProps) {
  return html`<span aria-hidden="true" ${mountAgentAvatar(props)}></span>`;
}

export function renderSelectPicker(props: SelectPickerProps, className = "") {
  return html`<div class=${className} ${mountSelectPicker(props)}></div>`;
}

export function renderAppearancePicker(props: AppearancePickerProps, className = "") {
  return html`<div class=${className} ${mountAppearancePicker(props)}></div>`;
}

export function renderAppearanceGlyph(props: AppearanceGlyphProps, className = "") {
  return html`<span
    class=${className}
    style="--workboard-board-color: var(--appearance-color, var(--muted))"
    aria-hidden="true"
    ${mountAppearanceGlyph(props)}
  ></span>`;
}

export function renderSessionSummary(props: SessionSummaryProps) {
  return html`<div class="workboard-session-summary" ${mountSessionSummary(props)}></div>`;
}
