import type { MatrixStreamingConfig, MatrixStreamingMode } from "../../types.js";

export function resolveMatrixStreamingMode(
  streaming: MatrixStreamingConfig | undefined,
): MatrixStreamingMode {
  const mode = streaming?.mode;
  if (mode === "partial" || mode === "quiet" || mode === "progress") {
    return mode;
  }
  return "off";
}

export function resolveMatrixPreviewToolProgressEnabled(
  streaming: MatrixStreamingConfig | undefined,
  mode = resolveMatrixStreamingMode(streaming),
): boolean {
  if (mode === "off") {
    return false;
  }
  if (mode === "progress") {
    // Progress drafts are quiet unless the operator opts into the tool log.
    return streaming?.progress?.toolProgress ?? streaming?.preview?.toolProgress ?? false;
  }
  return streaming?.preview?.toolProgress ?? true;
}
