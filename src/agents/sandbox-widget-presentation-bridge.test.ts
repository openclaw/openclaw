import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it, onTestFinished, vi } from "vitest";
import { buildSandboxWidgetPresentationBridgeHtml } from "./sandbox-widget-presentation-bridge.js";

class HostMessage {
  readonly isTrusted = true;
  constructor(
    private readonly payload: unknown,
    private readonly sender: unknown,
  ) {}
  get data() {
    return this.payload;
  }
  get source() {
    return this.sender;
  }
  get origin() {
    return "https://sandbox.example";
  }
}
class TrustedTouch {
  readonly isTrusted = true;
  defaultPrevented = false;
  constructor(readonly touches: { screenX: number; screenY: number }[]) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
}
function fixture() {
  const dom = new JSDOM("<html><head></head><body><button>Clock</button></body></html>");
  onTestFinished(() => dom.window.close());
  const handlers = new Map<string, (event: unknown) => void>();
  const pending: (() => void)[] = [];
  const parent = {};
  const window = {
    parent,
    addEventListener: (key: string, fn: (e: unknown) => void) => handlers.set(key, fn),
  };
  runInNewContext(buildSandboxWidgetPresentationBridgeHtml().slice(8, -9), {
    window,
    document: dom.window.document,
    URL,
    location: { ancestorOrigins: ["https://sandbox.example"] },
    MessageEvent: HostMessage,
    Event: TrustedTouch,
    CSSStyleDeclaration: dom.window.CSSStyleDeclaration,
    setTimeout: (fn: () => void) => pending.push(fn),
  });
  const packet = (payload: unknown, sender = parent) => {
    handlers.get("message")?.(new HostMessage(payload, sender));
    while (pending.length) {
      pending.shift()?.();
    }
  };
  const presentation = (collapsed: boolean) =>
    packet({
      type: "openclaw:widget-board-host",
      nonce: "fixture",
      presentation: { lobby: true, collapsed },
    });
  const touch = (type: string, span: number, count = 2) => {
    // Browser/native integration proves actual trusted dispatch; here the platform event is controlled.
    const event = new TrustedTouch(
      Array.from({ length: count }, (_, i) => ({ screenX: i * span, screenY: 0 })),
    );
    handlers.get(type)?.(event);
    return event.defaultPrevented;
  };
  return { document: dom.window.document, packet, presentation, touch, parent };
}
it("clamps component zoom without replacing content or consuming single-finger scrolling", () => {
  const f = fixture(),
    button = f.document.querySelector("button");
  const listener = vi.fn();
  button?.addEventListener("click", listener);
  f.presentation(false);
  expect(f.touch("touchstart", 100)).toBe(true);
  expect(f.touch("touchmove", 900)).toBe(true);
  expect(f.document.documentElement.style.scale).toBe("3");
  expect(f.touch("touchmove", 1)).toBe(true);
  expect(f.document.documentElement.style.scale).toBe("");
  expect(f.touch("touchmove", 200)).toBe(true);
  expect(f.document.documentElement.style.scale).toBe("2");
  expect(f.touch("touchmove", 100, 1)).toBe(false);
  expect(f.document.querySelector("button")).toBe(button);
  button?.click();
  expect(listener).toHaveBeenCalledOnce();
});
it("collapse restores authored root styling and leaves the live body untouched", () => {
  const f = fixture();
  f.document.documentElement.style.setProperty("scale", "1.05");
  f.document.documentElement.style.setProperty("transform-origin", "0 0", "important");
  f.document.body.style.transform = "translateX(2px)";
  f.presentation(false);
  f.touch("touchstart", 100);
  f.touch("touchmove", 200);
  f.presentation(true);
  expect(f.document.documentElement.style.scale).toBe("1.05");
  expect(f.document.documentElement.style.transformOrigin).toBe("0 0");
  expect(f.document.documentElement.style.getPropertyPriority("transform-origin")).toBe(
    "important",
  );
  expect(f.document.body.style.transform).toBe("translateX(2px)");
  expect(f.touch("touchstart", 100)).toBe(false);
  f.presentation(false);
  f.touch("touchstart", 100);
  f.touch("touchmove", 150);
  expect(f.document.documentElement.style.scale).toBe("1.5");
});
it("ordinary boards, unbound documents and foreign host messages keep normal gestures", () => {
  const f = fixture();
  const payload = {
    type: "openclaw:widget-board-host",
    nonce: "fixture",
    presentation: { lobby: true, collapsed: false },
  };
  f.packet(payload, {});
  expect(f.touch("touchstart", 100)).toBe(false);
  f.packet({ type: "openclaw:widget-board-host", nonce: "fixture" });
  expect(f.touch("touchstart", 100)).toBe(false);
  const getter = vi.fn(() => payload.presentation);
  f.packet(
    Object.defineProperty({ type: payload.type, nonce: payload.nonce }, "presentation", {
      get: getter,
    }),
  );
  expect(getter).not.toHaveBeenCalled();
  expect(f.document.documentElement.style.scale).toBe("");
});

it("returning a retained frame to an ordinary board restores its gesture ownership", () => {
  const f = fixture();
  f.presentation(false);
  f.touch("touchstart", 100);
  f.touch("touchmove", 200);
  expect(f.document.documentElement.style.scale).toBe("2");
  f.packet({ type: "openclaw:widget-board-host", nonce: "fixture" });
  expect(f.document.documentElement.style.scale).toBe("");
  expect(f.touch("touchstart", 100)).toBe(false);
});
