import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { vi } from "vitest";

/** The fixture exposes only the DOM-mount contract; host component internals have their own tests. */
export function installDomComponents(host: ControlUiHost): void {
  host.components.mountFilterChoices = vi.fn<ControlUiHost["components"]["mountFilterChoices"]>(
    (container, initial) => {
      const element = document.createElement("div");
      element.setAttribute("role", "group");
      const apply = (props: typeof initial) => {
        element.setAttribute("aria-label", props.label);
        element.replaceChildren(
          ...props.options.map((option) => {
            const button = document.createElement("button");
            button.textContent = option.label;
            button.setAttribute("aria-label", option.title ?? option.label);
            button.setAttribute("aria-pressed", String(props.value === option.value));
            button.addEventListener("click", () => props.onChange(option.value));
            return button;
          }),
        );
      };
      apply(initial);
      container.append(element);
      return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
    },
  );
  host.components.mountFilterSwitch = vi.fn<ControlUiHost["components"]["mountFilterSwitch"]>(
    (container, initial) => {
      const element = document.createElement("label");
      const label = document.createElement("span");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("role", "switch");
      element.append(label, input);
      let props = initial;
      input.addEventListener("change", () => props.onChange(input.checked));
      const apply = (next: typeof initial) => {
        props = next;
        label.textContent = next.label;
        input.checked = next.checked;
      };
      apply(initial);
      container.append(element);
      return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
    },
  );
  host.components.mountDialog = vi.fn((container, initial) => {
    const element = document.createElement("section");
    element.dataset.testDialog = "";
    let props = initial;
    const apply = (next: typeof initial) => {
      props = next;
      element.setAttribute("aria-label", next.label);
      element.setAttribute("aria-description", next.description ?? "");
      element.className = next.className ?? "";
      if (element.firstChild !== next.content) {
        element.replaceChildren(next.content);
      }
    };
    element.addEventListener("cancel", (event) => {
      if (props.onCancel() === false) {
        event.preventDefault();
      }
    });
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAgentPicker = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAgentPicker = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountSelectPicker = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testSelectPicker = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAgentAvatar = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAgentAvatar = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAppearancePicker = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAppearancePicker = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAppearanceGlyph = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAppearanceGlyph = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountSessionSummary = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testSessionSummary = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountDashboard = vi.fn((container, initial) => {
    const element = document.createElement("section");
    element.dataset.testDashboard = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
}
