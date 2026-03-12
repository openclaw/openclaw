/**
 * ExecBrowserHelper -- translates IBrowserCapable method calls into
 * `node -e` Playwright scripts executed inside containers via an injected
 * exec function.
 *
 * Both DockerProvider and GVisorProvider delegate browser automation here.
 * The helper generates self-contained Node.js scripts that:
 *   1. Use Playwright's chromium API inside the container
 *   2. Output JSON results wrapped in nonce-based markers (anti-spoofing)
 *   3. Embed user values via JSON.stringify (never raw shell interpolation)
 */

import { validateBrowserURL } from "../hardening/browser-security.js";
import type {
  ExecResult,
  BrowserSessionResult,
  BrowserScreenshotResult,
  BrowserPageInfo,
} from "../provider.js";
import type { SandboxBrowserConfig } from "../types.js";

/**
 * The exec function signature injected by the provider.
 * Maps to ISandboxProvider.exec() with containerName as first arg.
 */
export type ExecFn = (
  containerName: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<ExecResult>;

const DEFAULT_LAUNCH_TIMEOUT = 30_000;
const NAVIGATE_TIMEOUT_BUFFER = 5_000;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 720;

/**
 * Generate a per-invocation nonce-based marker to prevent untrusted page
 * content from spoofing the result boundary. Each call returns a unique
 * pair so collisions with page output are infeasible.
 */
function generateMarkers(): { start: string; end: string } {
  const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join(
    "",
  );
  return {
    start: `---PW_RESULT_${nonce}---`,
    end: `---PW_END_${nonce}---`,
  };
}

export class ExecBrowserHelper {
  private readonly execFn: ExecFn;

  constructor(execFn: ExecFn) {
    this.execFn = execFn;
  }

  /**
   * Per-container session file path. Avoids collisions when multiple
   * containers run browser sessions simultaneously and restricts
   * readability via the dot-prefix convention.
   */
  private sessionFilePath(containerName: string): string {
    return `/tmp/.pw-session-${containerName}.json`;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Shell-escape a string by wrapping in single quotes and escaping internal
   * single quotes with the '\'' idiom.
   */
  private shellEscape(script: string): string {
    return "'" + script.replace(/'/g, "'\\''") + "'";
  }

  /**
   * Extract JSON from stdout using the provided markers. Falls back
   * to parsing the entire string. Throws descriptive error on failure.
   */
  private parseResult<T>(stdout: string, markers: { start: string; end: string }): T {
    const startIdx = stdout.indexOf(markers.start);
    const endIdx = stdout.lastIndexOf(markers.end);

    let jsonStr: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonStr = stdout.substring(startIdx + markers.start.length, endIdx).trim();
    } else {
      jsonStr = stdout.trim();
    }

    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      const truncated = stdout.length > 4096 ? stdout.slice(0, 4096) + "... [truncated]" : stdout;
      throw new Error(`Failed to parse Playwright result. Raw stdout: ${truncated}`);
    }
  }

  /**
   * Run a node -e script inside the container via sh -c.
   * Checks exit code and returns stdout as string.
   */
  private async runScript(
    containerName: string,
    script: string,
    timeoutMs: number,
  ): Promise<string> {
    const result = await this.execFn(
      containerName,
      ["sh", "-c", "node -e " + this.shellEscape(script)],
      { timeout: timeoutMs },
    );

    if (result.code !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(stderr || `Playwright script exited with code ${result.code}`);
    }

    return result.stdout.toString();
  }

  /**
   * Build a Node.js script that connects to an existing Playwright browser
   * session via CDP, gets the first page, and executes the provided body code.
   *
   * The body code has access to variables: `browser`, `page`, `session`.
   * It must assign the result to the `__result` variable.
   */
  private connectScript(
    containerName: string,
    bodyCode: string,
    markers: { start: string; end: string },
  ): string {
    const sessionFile = this.sessionFilePath(containerName);
    return `
const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
  const session = JSON.parse(fs.readFileSync(${JSON.stringify(sessionFile)}, 'utf8'));
  const browser = await chromium.connectOverCDP(session.wsEndpoint);
  const contexts = browser.contexts();
  const ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = ctx.pages();
  const page = pages.length > 0 ? pages[0] : await ctx.newPage();
  let __result;
  ${bodyCode}
  const output = ${JSON.stringify(markers.start)} + '\\n' + JSON.stringify(__result) + '\\n' + ${JSON.stringify(markers.end)};
  process.stdout.write(output);
  await browser.disconnect();
})().catch(e => { process.stderr.write(e.message); process.exit(1); });
`.trim();
  }

  // ---------------------------------------------------------------------------
  // Public methods (match IBrowserCapable signatures, containerName instead of sandboxId)
  // ---------------------------------------------------------------------------

  async launchBrowser(
    containerName: string,
    config?: SandboxBrowserConfig,
  ): Promise<BrowserSessionResult> {
    const headless = config?.headless !== false;
    const vw = DEFAULT_VIEWPORT_WIDTH;
    const vh = DEFAULT_VIEWPORT_HEIGHT;

    // Script that launches Chromium persistently and writes session info.
    const sessionFile = this.sessionFilePath(containerName);
    const launchScript = `
const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: ${headless},
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: ${vw}, height: ${vh} } });
  await context.newPage();
  const wsEndpoint = browser.wsEndpoint ? browser.wsEndpoint() : '';
  if (!wsEndpoint) { process.stderr.write('Chromium launched but wsEndpoint is empty'); process.exit(1); }
  const sessionData = { wsEndpoint, pid: process.pid };
  fs.writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify(sessionData), { mode: 0o600 });
  // Keep process alive
  await new Promise(() => {});
})().catch(e => { process.stderr.write(e.message); process.exit(1); });
`.trim();

    // Fire the launch script in background via nohup
    await this.execFn(
      containerName,
      ["sh", "-c", "nohup node -e " + this.shellEscape(launchScript) + " > /dev/null 2>&1 &"],
      { timeout: DEFAULT_LAUNCH_TIMEOUT },
    );

    // Wait briefly for Chromium to start, then read session file
    const markers = generateMarkers();
    const catScript = `
const fs = require('fs');
(async () => {
  // Poll for session file up to 10s
  for (let i = 0; i < 20; i++) {
    try {
      const data = fs.readFileSync(${JSON.stringify(sessionFile)}, 'utf8');
      const session = JSON.parse(data);
      if (session.wsEndpoint && session.pid) {
        const output = ${JSON.stringify(markers.start)} + '\\n' + JSON.stringify(session) + '\\n' + ${JSON.stringify(markers.end)};
        process.stdout.write(output);
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  process.stderr.write('Timed out waiting for Playwright session');
  process.exit(1);
})();
`.trim();

    const stdout = await this.runScript(containerName, catScript, DEFAULT_LAUNCH_TIMEOUT);

    const session = this.parseResult<{ wsEndpoint: string; pid: number }>(stdout, markers);
    return { sessionId: `exec-${session.pid}` };
  }

  async navigateBrowser(
    containerName: string,
    _sessionId: string,
    url: string,
    timeoutMs?: number,
  ): Promise<{ url: string; title: string }> {
    // Validate URL before sending to container (SSRF prevention).
    validateBrowserURL(url);

    const navTimeout = timeoutMs ?? 30_000;
    const execTimeout = navTimeout + NAVIGATE_TIMEOUT_BUFFER;
    const markers = generateMarkers();

    const body = `
  await page.goto(${JSON.stringify(url)}, { timeout: ${navTimeout} });
  __result = { url: page.url(), title: await page.title() };
`;

    const stdout = await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      execTimeout,
    );

    const result = this.parseResult<{ url: string; title: string }>(stdout, markers);

    // Post-navigation SSRF check: validate the final URL after any redirects.
    if (result.url !== url) {
      validateBrowserURL(result.url);
    }

    return result;
  }

  async clickBrowser(containerName: string, _sessionId: string, selector: string): Promise<void> {
    const body = `
  await page.click(${JSON.stringify(selector)});
  __result = { ok: true };
`;
    const markers = generateMarkers();
    await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      DEFAULT_LAUNCH_TIMEOUT,
    );
  }

  async typeBrowser(
    containerName: string,
    _sessionId: string,
    selector: string,
    text: string,
  ): Promise<void> {
    const body = `
  await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(text)});
  __result = { ok: true };
`;
    const markers = generateMarkers();
    await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      DEFAULT_LAUNCH_TIMEOUT,
    );
  }

  async screenshotBrowser(
    containerName: string,
    _sessionId: string,
    opts?: { fullPage?: boolean; quality?: number },
  ): Promise<BrowserScreenshotResult> {
    const fullPage = opts?.fullPage ?? false;

    const body = `
  const buf = await page.screenshot({ fullPage: ${fullPage} });
  __result = { data: buf.toString('base64') };
`;
    const markers = generateMarkers();
    const stdout = await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      DEFAULT_LAUNCH_TIMEOUT,
    );

    const parsed = this.parseResult<{ data: string }>(stdout, markers);
    return { data: Buffer.from(parsed.data, "base64") };
  }

  async evaluateJS(containerName: string, _sessionId: string, expression: string): Promise<string> {
    const body = `
  const evalResult = await page.evaluate(${JSON.stringify(expression)});
  __result = { result: String(evalResult) };
`;
    const markers = generateMarkers();
    const stdout = await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      DEFAULT_LAUNCH_TIMEOUT,
    );

    const parsed = this.parseResult<{ result: string }>(stdout, markers);
    return parsed.result;
  }

  async extractContent(
    containerName: string,
    _sessionId: string,
    selector: string,
  ): Promise<{ text: string; html: string }> {
    const body = `
  const el = await page.$(${JSON.stringify(selector)});
  const text = el ? await el.textContent() || '' : '';
  const html = el ? await el.innerHTML() || '' : '';
  __result = { text, html };
`;

    const markers = generateMarkers();
    const stdout = await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      DEFAULT_LAUNCH_TIMEOUT,
    );

    return this.parseResult<{ text: string; html: string }>(stdout, markers);
  }

  async waitForSelector(
    containerName: string,
    _sessionId: string,
    selector: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    const waitTimeout = timeoutMs ?? 30_000;
    const execTimeout = waitTimeout + NAVIGATE_TIMEOUT_BUFFER;

    const body = `
  try {
    await page.waitForSelector(${JSON.stringify(selector)}, { timeout: ${waitTimeout} });
    __result = { found: true };
  } catch {
    __result = { found: false };
  }
`;
    const markers = generateMarkers();
    const stdout = await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      execTimeout,
    );

    const parsed = this.parseResult<{ found: boolean }>(stdout, markers);
    return parsed.found;
  }

  async getPageInfo(containerName: string, _sessionId: string): Promise<BrowserPageInfo> {
    const body = `
  __result = { title: await page.title(), url: page.url() };
`;
    const markers = generateMarkers();
    const stdout = await this.runScript(
      containerName,
      this.connectScript(containerName, body, markers),
      DEFAULT_LAUNCH_TIMEOUT,
    );

    return this.parseResult<BrowserPageInfo>(stdout, markers);
  }

  async closeBrowser(containerName: string, _sessionId: string): Promise<void> {
    const sessionFile = this.sessionFilePath(containerName);
    const killScript = `
const fs = require('fs');
(async () => {
  try {
    const data = fs.readFileSync(${JSON.stringify(sessionFile)}, 'utf8');
    const session = JSON.parse(data);
    process.kill(session.pid, 'SIGTERM');
  } catch {}
  try { fs.unlinkSync(${JSON.stringify(sessionFile)}); } catch {}
})();
`.trim();

    await this.execFn(containerName, ["sh", "-c", "node -e " + this.shellEscape(killScript)], {
      timeout: 10_000,
    });
  }
}
