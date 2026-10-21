import type { Browser, BrowserContext, Page } from "playwright-core";
import { vi } from "vitest";

export type MockPageSpec = {
  targetId?: string;
  url?: string;
  title?: string;
  beforeTargetLookup?: () => Promise<void>;
  targetLookupError?: string;
};

export function makeSelectionBrowser(specs: MockPageSpec[]) {
  let connected = true;
  const browserClose = vi.fn(async () => {
    connected = false;
  });
  const pageActions = specs.map(() => ({
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }));
  const pages = specs.map(
    (spec, index) =>
      ({
        on: vi.fn(),
        context: () => context,
        title: vi.fn(async () => spec.title ?? spec.targetId ?? `page-${index + 1}`),
        url: vi.fn(() => spec.url ?? `https://page-${index + 1}.example`),
        ...pageActions[index],
      }) as unknown as Page,
  );
  const context = {
    pages: () => pages,
    on: vi.fn(),
    browser: () => browser,
    newCDPSession: vi.fn(async (page: Page) => ({
      send: vi.fn(async (method: string) => {
        if (method !== "Target.getTargetInfo") {
          return {};
        }
        const spec = specs[pages.indexOf(page)];
        await spec?.beforeTargetLookup?.();
        if (spec?.targetLookupError) {
          throw new Error(spec.targetLookupError);
        }
        return { targetInfo: { targetId: spec?.targetId } };
      }),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as BrowserContext;
  const browser = {
    isConnected: () => connected,
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as Browser;
  return { browser, browserClose, context, pages, pageActions };
}

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
