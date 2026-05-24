import { describe, expect, it } from "vitest";
import {
  createChildTraceContext,
  createRootTraceContext,
  formatTraceparent,
  parseTraceparent,
  resolvePublishTraceparent,
} from "./trace-context.js";

describe("trace-context", () => {
  it("round-trips a valid traceparent header", () => {
    const root = createRootTraceContext();
    const traceparent = formatTraceparent(root)!;
    const parsed = parseTraceparent(traceparent);
    expect(parsed?.traceId).toBe(root.traceId);
    expect(parsed?.spanId).toBe(root.spanId);
    expect(parsed?.traceFlags).toBe(root.traceFlags);
  });

  it("creates child spans under the same trace id", () => {
    const root = createRootTraceContext();
    const child = createChildTraceContext(root);
    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).not.toBe(root.spanId);
  });

  it("rejects malformed traceparent values", () => {
    expect(parseTraceparent("not-a-trace")).toBeUndefined();
    expect(
      parseTraceparent("00-00000000000000000000000000000000-0000000000000000-01"),
    ).toBeUndefined();
  });

  it("resolvePublishTraceparent creates root when incoming is absent", () => {
    const traceparent = resolvePublishTraceparent(undefined);
    expect(parseTraceparent(traceparent)).toBeDefined();
  });

  it("resolvePublishTraceparent creates child when incoming is present", () => {
    const parent = formatTraceparent(createRootTraceContext())!;
    const child = resolvePublishTraceparent(parent);
    const parsedParent = parseTraceparent(parent)!;
    const parsedChild = parseTraceparent(child)!;
    expect(parsedChild.traceId).toBe(parsedParent.traceId);
    expect(parsedChild.spanId).not.toBe(parsedParent.spanId);
  });
});
