// Minimal type shim for jsdom used in structural mention-markup tests.
// jsdom ships without bundled type declarations; this covers only the
// JSDOM constructor and window.document surface needed by mentions.test.ts.
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string);
    readonly window: Window & typeof globalThis;
  }
}
