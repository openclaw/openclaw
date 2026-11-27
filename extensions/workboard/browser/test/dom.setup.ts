import { afterEach, beforeEach, vi } from "vitest";
import { installDomComponents } from "./dom-host.ts";
import { workboardTestHost } from "./host.setup.ts";

const missingPopoverMethods = (["showPopover", "hidePopover"] as const).filter(
  (method) => typeof HTMLElement.prototype[method] !== "function",
);
beforeEach(() => {
  // The unit DOM has no top layer. Browser coverage owns native dismissal behavior.
  for (const method of missingPopoverMethods) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
  installDomComponents(workboardTestHost().host);
});

afterEach(() => {
  document.body.replaceChildren();
  for (const method of missingPopoverMethods) {
    Reflect.deleteProperty(HTMLElement.prototype, method);
  }
});
