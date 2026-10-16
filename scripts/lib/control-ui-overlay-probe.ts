import path from "node:path";
import type { Page } from "playwright";

/** Capture the idle transcript before interaction, then measure first-open content admission. */
export async function probeColdLoadOverlays(page: Page, artifactDir: string, run: number) {
  const cold = await page.evaluate(() => {
    const mutations: Map<string, number> | undefined = Reflect.get(window, "__mutAttr");
    const perf: { loaf: Array<{ dur: number; block: number }>; mutTotal: number } | undefined =
      Reflect.get(window, "__perf");
    return {
      mutations: mutations ? Object.fromEntries(mutations) : undefined,
      loaf: perf?.loaf,
      mutationsTotal: perf?.mutTotal,
      closedPaletteButtons: document.querySelectorAll(".chat-reaction-picker .palette button")
        .length,
      widgetMenuItems: document.querySelectorAll(".chat-tool-card__widget-actions .oc-menu-item")
        .length,
      contextStats: document.querySelectorAll(".context-usage__stats").length,
      reasoningStops: document.querySelectorAll(".chat-controls__reasoning-dot").length,
    };
  });
  const firstOpen: Record<
    string,
    { readyMs: number; frameMs: number; renderOpportunityMs: number }
  > = {};
  for (const [name, triggerSelector, contentSelector] of [
    ["reaction", "openclaw-message-reaction-picker .trigger", ".chat-reaction-picker .palette"],
    [
      "widget",
      ".chat-tool-card__widget-actions-trigger",
      ".chat-tool-card__widget-actions .oc-menu-item",
    ],
    ["context", ".context-usage summary", ".context-usage__stats"],
    ["reasoning", ".chat-controls__effort-picker summary", ".chat-controls__reasoning-range"],
  ] as const) {
    firstOpen[name] = await page.evaluate(
      async ({ triggerSelector, contentSelector }) => {
        const trigger = document.querySelector<HTMLElement>(triggerSelector);
        if (!trigger) {
          throw new Error(`Missing overlay trigger: ${triggerSelector}`);
        }
        let readyAt: number | undefined;
        const started = performance.now();
        const check = () => {
          if (document.querySelector(contentSelector)) {
            readyAt ??= performance.now();
          }
        };
        const observer = new MutationObserver(check);
        observer.observe(document, { subtree: true, childList: true });
        trigger.click();
        check();
        await new Promise(requestAnimationFrame);
        const frameMs = performance.now() - started;
        observer.disconnect();
        if (readyAt === undefined) {
          throw new Error(`Overlay content missed its first frame: ${contentSelector}`);
        }
        if (!document.querySelector<HTMLElement>(contentSelector)?.checkVisibility()) {
          throw new Error(`Overlay content is not visible: ${contentSelector}`);
        }
        // A task posted after the ready rAF bounds rendering opportunity, not compositor presentation.
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };
          channel.port2.postMessage(null);
        });
        return {
          readyMs: readyAt - started,
          frameMs,
          renderOpportunityMs: performance.now() - started,
        };
      },
      { triggerSelector, contentSelector },
    );
    if (run === 0) {
      await page.screenshot({
        path: path.join(artifactDir, `overlay-${name}.png`),
        animations: "disabled",
      });
    }
    await page.keyboard.press("Escape");
  }
  return { cold, firstOpen };
}
