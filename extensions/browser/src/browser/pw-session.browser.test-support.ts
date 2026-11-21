import type { Browser, BrowserContext, Page } from "playwright-core";
import { vi } from "vitest";

export function makeTargetBrowser(targetId: string, url: string, title = `title:${targetId}`) {
  const browserClose = vi.fn(async () => {});
  const page = {
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => title),
    url: vi.fn(() => url),
  } as unknown as Page;
  const context = {
    pages: () => [page],
    on: vi.fn(),
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId, title } } : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as Browser;
  return { browser, browserClose, context, page };
}
