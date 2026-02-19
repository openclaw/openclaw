import type { BrowserContext, Page } from "playwright";

export class KeepAuthError extends Error {
  constructor() {
    super(
      "Google Keep: not logged in. Use the /keep login command to open a browser window and sign in.",
    );
    this.name = "KeepAuthError";
  }
}

type SessionLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type KeepSessionOptions = {
  profileDir: string;
  timeoutMs: number;
  logger: SessionLogger;
};

export class KeepSession {
  private context: BrowserContext | null = null;
  // Bug #1 fix: guard against concurrent launches
  private launching: Promise<BrowserContext> | null = null;
  // Bug #5 fix: track whether a login browser is open so getPage() blocks
  private loginContext: BrowserContext | null = null;

  constructor(private opts: KeepSessionOptions) {}

  private async launchContext(headless: boolean): Promise<BrowserContext> {
    const { chromium } = await import("playwright");
    return chromium.launchPersistentContext(this.opts.profileDir, { headless });
  }

  async getPage(): Promise<Page> {
    // Bug #5 fix: refuse headless pages while a login browser is open
    if (this.loginContext) {
      throw new Error(
        "Google Keep: a login browser is currently open. Complete sign-in before using the tool.",
      );
    }
    // Bug #1 fix: coalesce concurrent launch calls into one promise
    if (!this.context) {
      if (!this.launching) {
        this.opts.logger.info("google-keep: starting headless browser");
        this.launching = this.launchContext(true).then((ctx) => {
          this.context = ctx;
          this.launching = null;
          return ctx;
        });
      }
      await this.launching;
    }
    const pages = this.context!.pages();
    return pages[0] ?? (await this.context!.newPage());
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.launching = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
  }

  async openLoginBrowser(): Promise<{ page: Page; done: Promise<void> }> {
    await this.close();
    this.opts.logger.info("google-keep: opening visible browser for login");
    const ctx = await this.launchContext(false);
    // Bug #5 fix: store the login context so getPage() knows not to proceed
    this.loginContext = ctx;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://keep.google.com/", {
      timeout: this.opts.timeoutMs,
      waitUntil: "domcontentloaded",
    });

    // Resolved when login completes or times out
    const done = (async () => {
      try {
        await page.waitForURL((url) => url.hostname !== "accounts.google.com", {
          timeout: 5 * 60_000,
        });
      } catch {
        // timed out or browser closed manually
      } finally {
        try {
          await ctx.close();
        } catch {
          // ignore
        }
        this.loginContext = null;
      }
    })();

    return { page, done };
  }
}

// Bug #2 fix: check hostname only, not substring match
export function isAuthUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "accounts.google.com";
  } catch {
    return false;
  }
}
