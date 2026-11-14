import type { EventEmitter } from "node:events";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import {
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";

const log = createSubsystemLogger("browser").child("navigation");

type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
type StandingDocument = {
  url: string;
  headers: Record<string, string>;
  frameId?: string;
  mainFrameId?: string;
};

function networkOrigin(url: string): string | undefined {
  const origin = URL.parse(url)?.origin;
  return origin && origin !== "null" ? origin : undefined;
}

/** What a tab enforces on documents its page requests while no invocation claims them. */
export function createStandingNavigationPolicy() {
  let policy: BrowserNavigationPolicyOptions | undefined;
  let denialLogged = false;
  const frameOrigins = new Map<string, string>();
  const pageRequested = new Map<string, string>();
  const frameCommitted = (frameId: string, url: string) => {
    const origin = networkOrigin(url);
    if (origin) {
      frameOrigins.set(frameId, origin);
    } else {
      frameOrigins.delete(frameId);
    }
  };
  const seed = (tree: FrameTree) => {
    frameCommitted(tree.frame.id, tree.frame.url);
    for (const child of tree.childFrames ?? []) {
      seed(child);
    }
  };
  return {
    set(next: BrowserNavigationPolicyOptions) {
      policy = next;
    },
    frameCommitted,
    seed,
    /** Follow one target's frames; returns the unsubscribe. */
    observe(events: EventEmitter) {
      const committed = (event: { frame: { id: string; url: string } }) => {
        frameCommitted(event.frame.id, event.frame.url);
      };
      const requested = (event: { frameId: string; url: string }) => {
        // Paused requests carry the URL without its fragment.
        pageRequested.set(event.frameId, event.url.split("#", 1)[0] ?? event.url);
      };
      const removed = (event: { frameId: string; reason?: string }) => {
        // A frame swapping process keeps its place; its new target reports it.
        if (event.reason !== "swap") {
          frameOrigins.delete(event.frameId);
          pageRequested.delete(event.frameId);
        }
      };
      events.on("Page.frameNavigated", committed);
      events.on("Page.frameRequestedNavigation", requested);
      events.on("Page.frameDetached", removed);
      return () => {
        events.off("Page.frameNavigated", committed);
        events.off("Page.frameRequestedNavigation", requested);
        events.off("Page.frameDetached", removed);
      };
    },
    /**
     * How to stop a document, or undefined to let it load. `Aborted` keeps the
     * current document. `BlockedByClient` shows the browser's own blocked page,
     * for a navigation that looks like the person's (address bar, reload, back).
     */
    async denial(document: StandingDocument): Promise<"Aborted" | "BlockedByClient" | undefined> {
      const { frameId, mainFrameId } = document;
      const pageInitiated = frameId !== undefined && pageRequested.get(frameId) === document.url;
      if (pageInitiated) {
        pageRequested.delete(frameId);
      }
      if (!policy) {
        return undefined;
      }
      // A page can already fetch its own origin, so a document from the origin
      // its frame or tab is on reaches nothing new: reloads and in-app links work.
      const origin = networkOrigin(document.url);
      if (
        origin &&
        ((frameId && frameOrigins.get(frameId) === origin) ||
          (mainFrameId && frameOrigins.get(mainFrameId) === origin))
      ) {
        return undefined;
      }
      try {
        await assertBrowserNavigationAllowed({ url: document.url, ...policy });
        return undefined;
      } catch (error) {
        if (!denialLogged) {
          denialLogged = true;
          // The URL is page-controlled content; the tab's first denial names only its kind.
          log.warn(
            `Stopped a document the page requested between browser actions (${error instanceof Error ? error.name : "error"}).`,
          );
        }
      }
      // A page can imitate a browser-initiated navigation, so this only chooses how
      // the denial looks. Either way the request never leaves the browser.
      const hasReferrer = Object.keys(document.headers).some(
        (name) => name.toLowerCase() === "referer",
      );
      return frameId === mainFrameId && !pageInitiated && !hasReferrer
        ? "BlockedByClient"
        : "Aborted";
    },
  };
}
