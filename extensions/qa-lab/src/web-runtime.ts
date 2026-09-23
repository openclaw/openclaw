import { spawnSync } from "node:child_process";
// Qa Lab plugin module implements web runtime behavior.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

type QaWebSession = {
  browser?: Browser;
  context?: BrowserContext;
  ready?: { page: Page; diagnostics: QaWebDiagnosticEntry[] };
  acquisition: Promise<{ pageId: string; url: string; title: string }>;
  closing?: Promise<unknown[]>;
  owner?: Set<string>;
  signal?: AbortSignal;
};

type QaWebDiagnosticEntry = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

type QaWebOpenPageParams = {
  url: string;
  headless?: boolean;
  channel?: "chrome";
  repoRoot?: string;
  timeoutMs?: number;
  viewport?: { width: number; height: number };
};

type QaWebWaitParams = {
  pageId: string;
  selector?: string;
  text?: string;
  timeoutMs?: number;
};

type QaWebTypeParams = {
  pageId: string;
  selector: string;
  text: string;
  submit?: boolean;
  timeoutMs?: number;
};

type QaWebSnapshotParams = {
  pageId: string;
  timeoutMs?: number;
  maxChars?: number;
};

type QaWebEvaluateParams = {
  pageId: string;
  expression: string;
  timeoutMs?: number;
};

const sessions = new Map<string, QaWebSession>();
const closedSessionOwners = new WeakSet<Set<string>>();
const DEFAULT_WEB_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_ENTRIES = 50;
const MAX_DIAGNOSTIC_TEXT_CHARS = 2_000;
const PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH_ENV = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
const SYSTEM_CHROMIUM_EXECUTABLE_CANDIDATES = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

function appendDiagnostic(diagnostics: QaWebDiagnosticEntry[], entry: QaWebDiagnosticEntry): void {
  diagnostics.push({
    kind: entry.kind,
    text: truncateUtf16Safe(entry.text, MAX_DIAGNOSTIC_TEXT_CHARS),
  });
  if (diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
    diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
  }
}

function resolveTimeoutMs(timeoutMs: number | undefined, fallbackMs = DEFAULT_WEB_TIMEOUT_MS) {
  return resolvePositiveTimerTimeoutMs(timeoutMs, fallbackMs);
}

function resolveSession(pageId: string) {
  const session = sessions.get(pageId);
  if (!session?.ready || session.closing) {
    throw new Error(`unknown web session: ${pageId}`);
  }
  return session.ready;
}

function canRunChromiumExecutable(executablePath: string): boolean {
  const result = spawnSync(executablePath, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function resolveRunnableChromiumExecutablePath(): string | undefined {
  const executableOverride = process.env[PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH_ENV]?.trim();
  if (executableOverride) {
    return existsSync(executableOverride) && canRunChromiumExecutable(executableOverride)
      ? executableOverride
      : undefined;
  }
  return SYSTEM_CHROMIUM_EXECUTABLE_CANDIDATES.find(
    (candidate) => existsSync(candidate) && canRunChromiumExecutable(candidate),
  );
}

function ensureChromiumAvailable(repoRoot: string) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/ensure-playwright-chromium.mts", "--skip-ffmpeg"],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(`failed to ensure Playwright Chromium; status=${result.status ?? "unknown"}`);
  }
}

function buildChromiumLaunchOptions(params: QaWebOpenPageParams) {
  const baseOptions = {
    headless: params.headless ?? true,
  };
  if (params.channel) {
    return {
      ...baseOptions,
      channel: params.channel,
    };
  }
  const executablePath = resolveRunnableChromiumExecutablePath();
  return executablePath
    ? {
        ...baseOptions,
        executablePath,
      }
    : baseOptions;
}

function assertSessionOpening(session: QaWebSession) {
  session.signal?.throwIfAborted();
  if (session.closing) {
    throw new Error("web session closed while opening");
  }
}

function closeSession(pageId: string, session: QaWebSession): Promise<unknown[]> {
  session.closing ??= Promise.resolve().then(async () => {
    const errors: unknown[] = [];
    const closingHandles = new Set<BrowserContext | Browser>();
    const closeKnownHandles = async () => {
      for (const handle of [session.context, session.browser]) {
        if (!handle || closingHandles.has(handle)) {
          continue;
        }
        closingHandles.add(handle);
        try {
          await handle.close();
        } catch (error) {
          errors.push(error);
        }
      }
    };
    // Playwright context/page acquisition has no timeout. Closing known handles
    // must unblock it before we join; a late handle still belongs to this close.
    await closeKnownHandles();
    await session.acquisition.catch(() => {});
    await closeKnownHandles();
    // A passing retry must not hide an earlier browser's failed cleanup.
    if (errors.length === 0) {
      sessions.delete(pageId);
      session.owner?.delete(pageId);
    }
    return errors;
  });
  return session.closing;
}

async function acquirePage(pageId: string, session: QaWebSession, params: QaWebOpenPageParams) {
  assertSessionOpening(session);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  if (!params.channel) {
    ensureChromiumAvailable(params.repoRoot ?? process.cwd());
  }
  const browser = await chromium.launch(buildChromiumLaunchOptions(params));
  session.browser = browser;
  assertSessionOpening(session);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: params.viewport ?? { width: 1440, height: 1080 },
  });
  session.context = context;
  assertSessionOpening(session);
  const page = await context.newPage();
  assertSessionOpening(session);
  const diagnostics: QaWebDiagnosticEntry[] = [];
  page.on("console", (message) => {
    appendDiagnostic(diagnostics, {
      kind: "console",
      text: `[${message.type()}] ${message.text()}`,
    });
  });
  page.on("pageerror", (error) => {
    appendDiagnostic(diagnostics, {
      kind: "pageerror",
      text: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });
  page.on("requestfailed", (request) => {
    appendDiagnostic(diagnostics, {
      kind: "requestfailed",
      text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    });
  });
  await page.goto(params.url, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
    ...(session.signal ? { signal: session.signal } : {}),
  });
  assertSessionOpening(session);
  const title = await page.title().catch(() => "");
  assertSessionOpening(session);
  session.ready = { page, diagnostics };
  return { pageId, url: page.url(), title };
}

async function openPage(params: QaWebOpenPageParams, owner?: Set<string>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (owner && closedSessionOwners.has(owner)) {
    throw new Error("web session owner is closed");
  }
  const pageId = randomUUID();
  const session: QaWebSession = {
    owner,
    signal,
    // Register before acquisition starts. Close joins this raw promise, never the
    // outward promise whose failure path waits for rollback.
    acquisition: Promise.resolve().then(() => acquirePage(pageId, session, params)),
  };
  sessions.set(pageId, session);
  owner?.add(pageId);
  const onAbort = () => {
    void closeSession(pageId, session);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const opened = await session.acquisition;
    assertSessionOpening(session);
    return opened;
  } catch (error) {
    const failure = signal?.aborted ? signal.reason : error;
    const cleanupErrors = await closeSession(pageId, session);
    if (cleanupErrors.length) {
      throw new AggregateError([failure, ...cleanupErrors], "web page open and cleanup failed", {
        cause: error,
      });
    }
    throw failure;
  } finally {
    // The signal owns only acquisition; ready pages remain owned by the suite.
    signal?.removeEventListener("abort", onAbort);
  }
}

export function qaWebOpenPage(params: QaWebOpenPageParams) {
  return openPage(params);
}

export function createQaWebPageOpener(owner: Set<string>, signal?: AbortSignal) {
  return (params: QaWebOpenPageParams) => openPage(params, owner, signal);
}

export async function qaWebWait(params: QaWebWaitParams) {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  if (params.selector) {
    await session.page.waitForSelector(params.selector, { timeout: timeoutMs });
    return { ok: true };
  }
  if (params.text) {
    await session.page.waitForFunction(
      (expected) => document.body?.textContent?.toLowerCase().includes(expected.toLowerCase()),
      params.text,
      { timeout: timeoutMs },
    );
    return { ok: true };
  }
  throw new Error("web wait requires selector or text");
}

export async function qaWebType(params: QaWebTypeParams) {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const locator = session.page.locator(params.selector).first();
  await locator.waitFor({ timeout: timeoutMs });
  await locator.fill(params.text, { timeout: timeoutMs });
  if (params.submit) {
    await locator.press("Enter", { timeout: timeoutMs });
  }
  return { ok: true };
}

export async function qaWebSnapshot(params: QaWebSnapshotParams) {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const body = session.page.locator("body");
  await body.waitFor({ timeout: timeoutMs });
  const text = (await body.textContent({ timeout: timeoutMs })) ?? "";
  const maxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars)
      ? Math.max(1, Math.floor(params.maxChars))
      : undefined;
  return {
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
    text: maxChars ? truncateUtf16Safe(text, maxChars) : text,
    diagnostics: [...session.diagnostics],
  };
}

export async function qaWebEvaluate<T = unknown>(params: QaWebEvaluateParams): Promise<T> {
  const session = resolveSession(params.pageId);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      session.page.evaluate(({ expression }) => (0, eval)(expression) as unknown, {
        expression: params.expression,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`web evaluate timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ])) as T;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function closeQaWebSessions(pageIds?: Iterable<string>): Promise<void> {
  // Suite teardown seals the exact owner even when no page has been opened yet.
  // Scenario deadlines do not seal it: later scenarios and retries reuse the Set.
  if (pageIds instanceof Set) {
    closedSessionOwners.add(pageIds);
  }
  const pending = [...(pageIds ?? sessions.keys())].flatMap((pageId) => {
    const session = sessions.get(pageId);
    return session ? [closeSession(pageId, session)] : [];
  });
  const errors = (await Promise.all(pending)).flat();
  if (errors.length) {
    throw new AggregateError(errors, "web session cleanup failed");
  }
}
