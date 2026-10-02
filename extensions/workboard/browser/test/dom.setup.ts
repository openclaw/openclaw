import { afterEach, beforeEach, vi } from "vitest";
import { installDomComponents } from "./dom-host.ts";
import { workboardTestHost } from "./host.setup.ts";

const hasNativeHidePopover = typeof HTMLElement.prototype.hidePopover === "function";
beforeEach(() => {
  // The unit DOM has no top layer. Browser coverage owns native dismissal behavior.
  if (!hasNativeHidePopover) {
    Object.defineProperty(HTMLElement.prototype, "hidePopover", {
      configurable: true,
      value: vi.fn(),
    });
  }
  installDomComponents(workboardTestHost().host);
});

afterEach(() => {
  document.body.replaceChildren();
  if (!hasNativeHidePopover) {
    Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
  }
});
