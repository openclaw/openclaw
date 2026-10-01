import { Text } from "@earendil-works/pi-tui";

interface VisualTruncateResult {
  visualLines: string[];
  skippedCount: number;
}

/**
 * Keep the tail after terminal wrapping.
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 */
export function truncateToVisualLines(
  text: string,
  maxVisualLines: number,
  width: number,
  paddingX = 0,
): VisualTruncateResult {
  if (!text) {
    return { visualLines: [], skippedCount: 0 };
  }

  const tempText = new Text(text, paddingX, 0);
  const allVisualLines = tempText.render(width);

  if (allVisualLines.length <= maxVisualLines) {
    return { visualLines: allVisualLines, skippedCount: 0 };
  }

  const truncatedLines = allVisualLines.slice(-maxVisualLines);
  const skippedCount = allVisualLines.length - maxVisualLines;

  return { visualLines: truncatedLines, skippedCount };
}
