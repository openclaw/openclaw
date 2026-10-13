import {
  SOURCE_LOCATION_KEY,
  USER_SOURCE_FILE,
  type SourceLocation,
} from "openclaw/plugin-sdk/code-mode-executor-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QuickJS } from "quickjs-wasi";

export function readSourceLocation(vm: QuickJS): SourceLocation | undefined {
  // Old snapshots have no record. Read data descriptors without invoking guest getters.
  const descriptor = vm.global.getOwnPropertyDescriptor(SOURCE_LOCATION_KEY);
  if (!descriptor) {
    return undefined;
  }
  try {
    if (
      descriptor.writable ||
      descriptor.configurable ||
      descriptor.enumerable ||
      !descriptor.value?.isString
    ) {
      return undefined;
    }
    const value: unknown = JSON.parse(descriptor.value.toString());
    if (!isRecord(value)) {
      return undefined;
    }
    const { file, lineOffset, lineCount, columnOffset, endColumn } = value;
    const isOffset = (offset: unknown): offset is number =>
      typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0;
    if (
      file !== USER_SOURCE_FILE ||
      !isOffset(lineOffset) ||
      !isOffset(lineCount) ||
      lineCount === 0 ||
      !isOffset(columnOffset) ||
      !isOffset(endColumn) ||
      endColumn === 0 ||
      !Number.isSafeInteger(lineOffset + lineCount) ||
      (lineCount === 1 && endColumn <= columnOffset)
    ) {
      return undefined;
    }
    return {
      file,
      lineOffset,
      lineCount,
      columnOffset,
      endColumn,
    };
  } catch {
    return undefined;
  } finally {
    descriptor.value?.dispose();
    descriptor.get?.dispose();
    descriptor.set?.dispose();
  }
}
