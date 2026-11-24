import { EventEmitter } from "node:events";
import vm from "node:vm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { Browser, BrowserContext, CDPSession, Frame, Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import { isHeadlessChromium } from "./pw-session-webauthn.js";
import { setupPwSessionConnectionTest } from "./pw-session.connection.test-support.js";

const { passkeyWarn } = vi.hoisted(() => ({ passkeyWarn: vi.fn<(message: string) => void>() }));

vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return {
        ...logger,
        child: (name: string) =>
          name === "webauthn" ? { ...logger.child(name), warn: passkeyWarn } : logger.child(name),
      };
    },
  };
});

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, pwAi } = setupPwSessionConnectionTest();
const { createPageViaPlaywright, getPageForTargetId, listPagesViaPlaywright } = pwAi;

const cdpUrl = "http://127.0.0.1:18899";
// SystemInfo.getInfo command lines as Chrome 155 reports them. The headless one
// overrides the user agent, so only the launch flag tells the modes apart.
const headlessCommandLine =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=18899 " +
  "--headless=new --disable-gpu --user-agent=Mozilla/5.0 (Macintosh) Chrome/155.0.0.0 Safari/537.36";
const headedCommandLine =
  "/usr/bin/google-chrome --remote-debugging-port=18899 --user-data-dir=/tmp/openclaw-profile";

type ChromiumOptions = {
  commandLine?: string;
  probeError?: Error;
  initScriptGate?: Promise<void>;
  initScriptFailures?: number;
  disconnectAfterProbe?: boolean;
};

function makeChromium(opts: ChromiumOptions = {}) {
  const events: string[] = [];
  const pages: Page[] = [];
  const targetIds = new WeakMap<object, string>();
  let initScriptFailures = opts.initScriptFailures ?? 0;
  const browserEvents = new EventEmitter();
  const probe = {
    send: vi.fn(async () => {
      if (opts.disconnectAfterProbe) {
        browserEvents.emit("disconnected");
      }
      return { commandLine: opts.commandLine ?? headedCommandLine };
    }),
    detach: vi.fn(async () => {}),
  };
  const makeContext = (name: string): BrowserContext => {
    const pageEvents = new EventEmitter();
    const context = {
      browser: () => browser,
      pages: () => pages.filter((page) => page.context() === context),
      on: (event: string, handler: (page: Page) => void) => pageEvents.on(event, handler),
      addInitScript: vi.fn(async (script: unknown) => {
        events.push(`${name}:addInitScript`);
        await opts.initScriptGate;
        if (initScriptFailures > 0) {
          initScriptFailures -= 1;
          throw new Error("Target page, context or browser has been closed");
        }
        scripts.push(script);
      }),
      newPage: vi.fn(async () => {
        events.push(`${name}:newPage`);
        return makePage(`NEW_${pages.length}`, context);
      }),
      newCDPSession: vi.fn(async (page: Page) => {
        const target = targetIds.get(page) ?? "unknown";
        return Object.assign(new EventEmitter(), {
          send: vi.fn(async (method: string) =>
            method === "Target.getTargetInfo"
              ? { targetInfo: { targetId: target, title: target } }
              : method === "Page.getFrameTree"
                ? { frameTree: { frame: { id: target } } }
                : {},
          ),
          detach: vi.fn(async () => {}),
        }) as unknown as CDPSession;
      }),
      close: vi.fn(async () => {}),
    } as unknown as BrowserContext;
    return context;
  };
  const makePage = (target: string, owner: BrowserContext): Page => {
    let url = "about:blank";
    const frames = ["main", "iframe"].map(
      (frame) =>
        ({
          evaluate: vi.fn(async (script: unknown) => {
            events.push(`${target}/${frame}:evaluate`);
            scripts.push(script);
          }),
        }) as unknown as Frame,
    );
    const page = Object.assign(new EventEmitter(), {
      isClosed: () => false,
      context: () => owner,
      frames: () => frames,
      url: () => url,
      title: async () => target,
      mainFrame: () => frames[0],
      route: vi.fn(async () => {}),
      unroute: vi.fn(async () => {}),
      goto: vi.fn(async (next: string) => {
        events.push(`${target}:goto`);
        url = next;
        return null;
      }),
      close: vi.fn(async () => {}),
    }) as unknown as Page;
    targetIds.set(page, target);
    pages.push(page);
    return page;
  };
  const scripts: unknown[] = [];
  const defaultContext = makeContext("default");
  const browser = {
    contexts: () => [defaultContext],
    newContext: vi.fn(async () => makeContext("isolated")),
    newBrowserCDPSession: vi.fn(async () => {
      if (opts.probeError) {
        throw opts.probeError;
      }
      return probe;
    }),
    isConnected: () => true,
    on: browserEvents.on.bind(browserEvents),
    off: browserEvents.off.bind(browserEvents),
    close: vi.fn(async () => {}),
  } as unknown as Browser;
  makePage("EXISTING", defaultContext);
  return { browser, events, scripts, probe };
}

const passkeyGuardEvents = (events: string[]) =>
  events.filter((event) => /addInitScript|evaluate/.test(event));
const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

beforeEach(() => {
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  passkeyWarn.mockReset();
});

describe("headless passkey guard on Playwright connections", () => {
  it("returns a new connection only after the guard is registered", async () => {
    const gate = createDeferred<void>();
    const chromium = makeChromium({
      commandLine: headlessCommandLine,
      initScriptGate: gate.promise,
    });
    connectOverCdpSpy.mockResolvedValue(chromium.browser);

    let listed = false;
    const listing = listPagesViaPlaywright({ cdpUrl }).then(() => {
      listed = true;
    });
    await settle();
    expect(chromium.events).toEqual(["default:addInitScript"]);
    expect(listed).toBe(false);

    gate.resolve();
    await listing;
    expect(listed).toBe(true);
  });

  it("registers the guard before a created page's first navigation, also in an isolated context", async () => {
    const chromium = makeChromium({ commandLine: headlessCommandLine });
    connectOverCdpSpy.mockResolvedValue(chromium.browser);
    await listPagesViaPlaywright({ cdpUrl });

    await expect(
      createPageViaPlaywright({
        cdpUrl,
        url: "https://93.184.216.34/sign-in",
        isolatedContext: true,
      }),
    ).resolves.toMatchObject({ targetId: "NEW_1" });
    expect(chromium.events.filter((event) => !event.startsWith("default:"))).toEqual([
      "EXISTING/main:evaluate",
      "EXISTING/iframe:evaluate",
      "isolated:addInitScript",
      "isolated:newPage",
      "NEW_1:goto",
    ]);
  });

  it("re-registers a guard that Playwright dropped on the next page access", async () => {
    const chromium = makeChromium({ commandLine: headlessCommandLine, initScriptFailures: 1 });
    connectOverCdpSpy.mockResolvedValue(chromium.browser);

    await listPagesViaPlaywright({ cdpUrl });
    expect(passkeyWarn).toHaveBeenCalledWith(
      expect.stringContaining("Passkey guard registration failed"),
    );
    await getPageForTargetId({ cdpUrl, targetId: "EXISTING" });
    await settle();

    expect(passkeyGuardEvents(chromium.events)).toEqual([
      "default:addInitScript",
      "default:addInitScript",
      "EXISTING/main:evaluate",
      "EXISTING/iframe:evaluate",
    ]);
  });

  it("leaves passkey requests to a headed browser", async () => {
    const chromium = makeChromium({ commandLine: headedCommandLine });
    connectOverCdpSpy.mockResolvedValue(chromium.browser);

    await listPagesViaPlaywright({ cdpUrl });
    await createPageViaPlaywright({ cdpUrl, url: "about:blank", isolatedContext: true });

    expect(passkeyGuardEvents(chromium.events)).toEqual([]);
    expect(passkeyWarn).not.toHaveBeenCalled();
  });

  it("uses the launch owner's headless mode before creating a page when detection fails", async () => {
    const chromium = makeChromium({ probeError: new Error("SystemInfo.getInfo is not allowed") });
    connectOverCdpSpy.mockResolvedValue(chromium.browser);

    await createPageViaPlaywright({ cdpUrl, url: "https://93.184.216.34/sign-in", headless: true });

    expect(chromium.events).toEqual([
      "default:addInitScript",
      "EXISTING/main:evaluate",
      "EXISTING/iframe:evaluate",
      "default:newPage",
      "NEW_1:goto",
    ]);
  });

  it("waits for a slow guard registration only once", async () => {
    vi.useFakeTimers();
    const registration = createDeferred<void>();
    const chromium = makeChromium({
      commandLine: headlessCommandLine,
      initScriptGate: registration.promise,
    });
    connectOverCdpSpy.mockResolvedValue(chromium.browser);

    const listing = listPagesViaPlaywright({ cdpUrl });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(listing).resolves.toHaveLength(1);
    let ready = false;
    void createPageViaPlaywright({ cdpUrl, url: "about:blank", headless: true }).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(ready).toBe(true);
    expect(passkeyWarn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Passkey guard registration is still waiting on an open page"),
    );
    registration.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(passkeyGuardEvents(chromium.events)).toEqual([
      "default:addInitScript",
      "EXISTING/main:evaluate",
      "EXISTING/iframe:evaluate",
      "NEW_1/main:evaluate",
      "NEW_1/iframe:evaluate",
    ]);
  });

  it("does not cache a browser that disconnected while it was being guarded", async () => {
    vi.useFakeTimers();
    const lost = makeChromium({ commandLine: headlessCommandLine, disconnectAfterProbe: true });
    const replacement = makeChromium({ commandLine: headlessCommandLine });
    connectOverCdpSpy
      .mockResolvedValueOnce(lost.browser)
      .mockResolvedValueOnce(replacement.browser);

    const listing = listPagesViaPlaywright({ cdpUrl });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(listing).resolves.toHaveLength(1);

    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    await getPageForTargetId({ cdpUrl, targetId: "EXISTING" });
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up on a launch-mode read that never answers and closes its late session", async () => {
    vi.useFakeTimers();
    const session = createDeferred<CDPSession>();
    const late = { send: vi.fn(), detach: vi.fn(async () => {}) };
    const browser = {
      newBrowserCDPSession: vi.fn(() => session.promise),
    } as unknown as Browser;

    const headless = isHeadlessChromium(browser);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(headless).resolves.toBe(false);
    session.resolve(late as unknown as CDPSession);
    await vi.advanceTimersByTimeAsync(0);

    expect(late.send).not.toHaveBeenCalled();
    expect(late.detach).toHaveBeenCalledOnce();
    expect(passkeyWarn).toHaveBeenCalledWith(expect.stringContaining("no answer within 5000 ms"));
  });
});

describe("headless passkey page script", () => {
  class FakeCredentialsContainer {
    get(options?: unknown) {
      return Promise.resolve({ method: "get", options, container: this });
    }
    create(options?: unknown) {
      return Promise.resolve({ method: "create", options, container: this });
    }
  }

  async function pageScript(): Promise<string> {
    const chromium = makeChromium({ commandLine: headlessCommandLine });
    connectOverCdpSpy.mockResolvedValue(chromium.browser);
    await listPagesViaPlaywright({ cdpUrl });
    const [script] = new Set(chromium.scripts);
    expect(script).toBeTypeOf("function");
    // Playwright sends the function source and calls it in the page.
    return `(${String(script)})(undefined)`;
  }

  async function runInFreshRealm(globals: Record<string, unknown>) {
    vm.runInNewContext(await pageScript(), globals);
  }

  it("answers modal passkey requests like a dismissed dialog, in a self-contained script", async () => {
    const Container = class extends FakeCredentialsContainer {};
    await runInFreshRealm({ CredentialsContainer: Container, DOMException });
    const credentials = new Container();
    const publicKey = { challenge: new Uint8Array(32) };

    await expect(credentials.get({ publicKey })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    await expect(credentials.create({ mediation: "immediate", publicKey })).rejects.toBeInstanceOf(
      DOMException,
    );
  });

  it("keeps conditional passkey and other credential requests native", async () => {
    const Container = class extends FakeCredentialsContainer {};
    await runInFreshRealm({ CredentialsContainer: Container, DOMException });
    const credentials = new Container();
    const conditional = { mediation: "conditional", publicKey: { challenge: new Uint8Array(32) } };

    await expect(credentials.get(conditional)).resolves.toEqual({
      method: "get",
      options: conditional,
      container: credentials,
    });
    await expect(credentials.get({ password: true })).resolves.toMatchObject({ method: "get" });
    await expect(credentials.create(conditional)).resolves.toMatchObject({ method: "create" });
  });
});
