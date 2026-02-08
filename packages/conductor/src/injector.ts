/**
 * Result Injector
 *
 * Takes the results from Aether's browser actions and formats them for
 * injection back into Claude's terminal. The injected text should look
 * natural so Claude can parse and use the information seamlessly.
 */

import type { TerminalInterceptor } from "./interceptor.js";
import type { BrowserActionResult, ConductorInjection, ExternalAccessRequest } from "./types.js";

/**
 * Format browser action results into a string suitable for terminal injection.
 */
export function formatInjectionPayload(
  request: ExternalAccessRequest,
  results: BrowserActionResult[],
): string {
  const lines: string[] = [];
  lines.push(`[Aether] External access result for: ${request.summary}`);

  const successfulResults = results.filter((r) => r.success);
  const failedResults = results.filter((r) => !r.success);

  if (successfulResults.length === 0 && failedResults.length > 0) {
    lines.push(`[Aether] All actions failed:`);
    for (const result of failedResults) {
      lines.push(`  - ${result.action.type}: ${result.error ?? "unknown error"}`);
    }
    return lines.join("\n");
  }

  // Collect extracted data
  for (const result of successfulResults) {
    switch (result.action.type) {
      case "navigate":
        lines.push(`[Aether] Navigated to: ${result.action.url}`);
        break;
      case "extract-text":
        if (result.data) {
          lines.push(`[Aether] Extracted content:`);
          lines.push(result.data);
        }
        break;
      case "screenshot":
        if (result.screenshotPath) {
          lines.push(`[Aether] Screenshot saved: ${result.screenshotPath}`);
        }
        break;
      case "scrape":
        if (result.data) {
          lines.push(`[Aether] Scraped data:`);
          lines.push(result.data);
        }
        break;
      case "click":
        lines.push(`[Aether] Clicked: ${result.action.selector}`);
        break;
      case "type":
        lines.push(`[Aether] Typed into: ${result.action.selector}`);
        break;
      default:
        if (result.data) {
          lines.push(`[Aether] ${result.action.type}: ${result.data}`);
        }
        break;
    }
  }

  if (failedResults.length > 0) {
    lines.push(`[Aether] Some actions failed:`);
    for (const result of failedResults) {
      lines.push(`  - ${result.action.type}: ${result.error ?? "unknown error"}`);
    }
  }

  return lines.join("\n");
}

/**
 * Inject results into the child process via the terminal interceptor.
 */
export function injectResults(
  interceptor: TerminalInterceptor,
  request: ExternalAccessRequest,
  results: BrowserActionResult[],
): ConductorInjection {
  const payload = formatInjectionPayload(request, results);
  const success = results.some((r) => r.success);

  // Inject into Claude's stdin so it reads it as user input
  interceptor.injectLine("");
  interceptor.injectLine(payload);
  interceptor.injectLine("");

  return {
    requestId: request.id,
    success,
    payload,
    actionResults: results,
    injectedAtMs: Date.now(),
  };
}

/**
 * Inject a denial message into the child process.
 */
export function injectDenial(
  interceptor: TerminalInterceptor,
  request: ExternalAccessRequest,
  reason?: string,
): ConductorInjection {
  const payload = `[Aether] Request denied: ${request.summary}${reason ? ` — ${reason}` : ""}. Proceeding without external access.`;

  interceptor.injectLine("");
  interceptor.injectLine(payload);
  interceptor.injectLine("");

  return {
    requestId: request.id,
    success: false,
    payload,
    injectedAtMs: Date.now(),
  };
}

/**
 * Inject a timeout message into the child process.
 */
export function injectTimeout(
  interceptor: TerminalInterceptor,
  request: ExternalAccessRequest,
): ConductorInjection {
  const payload = `[Aether] Authorization timed out for: ${request.summary}. Proceeding without external access.`;

  interceptor.injectLine("");
  interceptor.injectLine(payload);
  interceptor.injectLine("");

  return {
    requestId: request.id,
    success: false,
    payload,
    injectedAtMs: Date.now(),
  };
}
