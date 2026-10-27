import type { Component } from "@earendil-works/pi-tui";
import type { createReadToolDefinition } from "./read.js";

export function readRenderContext(
  filePath: string,
  lastComponent?: Component,
): Parameters<NonNullable<ReturnType<typeof createReadToolDefinition>["renderCall"]>>[2] {
  return {
    args: { path: filePath },
    toolCallId: "read-render",
    invalidate: () => {},
    lastComponent,
    state: {},
    cwd: "/workspace",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
  };
}
