import * as os from "node:os";
import {
  type Component,
  getCapabilities,
  getImageDimensions,
  imageFallback,
  Text,
} from "@earendil-works/pi-tui";
import { shortenPathWithHome } from "../../../infra/home-display.js";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { sanitizeBinaryOutput } from "../../shell-utils.js";

/** Shortens paths under the current home directory for display. */
export function shortenPath(path: unknown): string {
  if (typeof path !== "string") {
    return "";
  }
  return shortenPathWithHome(path, { home: os.homedir(), prefix: "~" });
}

/** Returns a display string for string/nullish values, or null for unsupported values. */
export function str(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return null;
}

/** Replaces tabs with stable spaces so terminal layout does not shift by tab stop. */
export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  return lines.slice(0, lines.findLastIndex((line) => line !== "") + 1);
}

export function reuseTextComponent(lastComponent: Component | undefined, content: string): Text {
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0); // SAFETY: Render slots only reuse the component returned by this renderer.
  text.setText(content);
  return text;
}
/** Extracts text output and image placeholders from a tool result. */
export function getTextOutput(
  result:
    | { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }
    | undefined,
  showImages: boolean,
): string {
  if (!result) {
    return "";
  }

  const textBlocks = result.content.filter((c) => c.type === "text");
  const imageBlocks = result.content.filter((c) => c.type === "image");

  let output = textBlocks
    .map((c) => sanitizeBinaryOutput(c.text || "", { ansiMode: "compat" }).replace(/\r/g, ""))
    .join("\n");

  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    // When inline images are unavailable, preserve visible evidence that media was returned.
    const imageIndicators = imageBlocks
      .map((img) => {
        const mimeType = img.mimeType ?? "image/unknown";
        const dims =
          img.data && img.mimeType
            ? (getImageDimensions(img.data, img.mimeType) ?? undefined)
            : undefined;
        return imageFallback(mimeType, dims);
      })
      .join("\n");
    output = output ? `${output}\n${imageIndicators}` : imageIndicators;
  }

  return output;
}

/** Formats the invalid-argument marker with the active theme. */
export function invalidArgText(theme: Pick<Theme, "fg">): string {
  return theme.fg("error", "[invalid arg]");
}
