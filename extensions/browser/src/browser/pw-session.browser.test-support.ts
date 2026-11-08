import type { Browser, BrowserContext, Page } from "playwright-core";
import { vi } from "vitest";

export function makeTargetBrowser(targetId: string, url: string, title = `title:${targetId}`) {
  const browserClose = vi.fn(async () => {});
  const pageHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const page = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = pageHandlers.get(event) ?? [];
      handlers.push(handler);
      pageHandlers.set(event, handlers);
    }),
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
  // Playwright page events reach the browser session through these handlers; expose them so tests
  // can fire crash/close without reaching into the mocked Page object.
  const emitPageEvent = (event: string, ...args: unknown[]) => {
    for (const handler of pageHandlers.get(event) ?? []) {
      handler(...args);
    }
  };
  const countPageEventHandlers = (event: string) => (pageHandlers.get(event) ?? []).length;
  return { browser, browserClose, context, page, emitPageEvent, countPageEventHandlers };
}
