import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createBoundedUtf8Tail } from "./bounded-utf8-tail.js";
import { CHROME_STDERR_HINT_MAX_CHARS } from "./cdp-timeouts.js";

const CHROME_SINGLETON_IN_USE_PATTERN = /profile appears to be in use by another chromium process/i;
const CHROME_MISSING_DISPLAY_PATTERN = /missing x server|\$DISPLAY/i;
const CHROME_LAUNCH_STDERR_TAIL_MAX_BYTES = 64 * 1024;
const CHROME_STDERR_MARKER_SCAN_TAIL_CHARS = 256;

type ChromeLaunchStderrSignals = {
  singletonInUse: boolean;
  missingDisplay: boolean;
};

export function createChromeLaunchStderrDiagnostics() {
  const tail = createBoundedUtf8Tail(CHROME_LAUNCH_STDERR_TAIL_MAX_BYTES);
  const signals: ChromeLaunchStderrSignals = {
    singletonInUse: false,
    missingDisplay: false,
  };
  let markerScanTail = "";

  return {
    append: (chunk: Buffer | string) => {
      tail.append(chunk);
      const chunkText = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (chunkText.length > 0) {
        const scanText = `${markerScanTail}${chunkText}`;
        signals.singletonInUse ||= CHROME_SINGLETON_IN_USE_PATTERN.test(scanText);
        signals.missingDisplay ||= CHROME_MISSING_DISPLAY_PATTERN.test(scanText);
        markerScanTail = scanText.slice(-CHROME_STDERR_MARKER_SCAN_TAIL_CHARS);
      }
    },
    hint() {
      const output = redactToolPayloadText(tail.text().trim());
      // Chromium stack dumps can push the actual failure out of a short tail.
      const fatal = output.match(/^.*\bFATAL:.*$/gmu)?.join("\n");
      const excerpt = fatal
        ? sliceUtf16Safe(fatal, 0, CHROME_STDERR_HINT_MAX_CHARS)
        : sliceUtf16Safe(output, -CHROME_STDERR_HINT_MAX_CHARS);
      return excerpt ? `\nChrome stderr:\n${excerpt}` : "";
    },
    signals(): ChromeLaunchStderrSignals {
      return { ...signals };
    },
    clear() {
      tail.clear();
      signals.singletonInUse = false;
      signals.missingDisplay = false;
      markerScanTail = "";
    },
  };
}
