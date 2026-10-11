import type { Page } from "playwright-core";
import { browserAnnotationOaiAdapterSource } from "./annotation-oai-adapter.js";
import { browserAnnotationRuntimeSource } from "./annotation-runtime.js";

export const browserAnnotationBootstrapSource = `${browserAnnotationRuntimeSource}\n${browserAnnotationOaiAdapterSource}`;
const installed = new WeakMap<Page, Promise<void>>();

/** Add once per Playwright page, before navigation when the page is host-created. */
export async function installBrowserAnnotationsOnPage(page: Page): Promise<void> {
  let installing = installed.get(page);
  if (!installing) {
    installing = page.addInitScript({ content: browserAnnotationBootstrapSource }).then(() => {});
    installed.set(page, installing);
    void installing.catch(() => {
      if (installed.get(page) === installing) {
        installed.delete(page);
      }
    });
  }
  await installing;
}
