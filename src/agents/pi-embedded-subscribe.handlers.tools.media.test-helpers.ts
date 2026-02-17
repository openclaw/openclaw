import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Mock } from "vitest";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import type { SubscribeEmbeddedPiSessionParams } from "./pi-embedded-subscribe.types.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";

/**
 * Narrowed params type that omits the `session` class instance (never accessed
 * by the handler paths under test).
 */
type TestParams = Omit<SubscribeEmbeddedPiSessionParams, "session">;

/**
 * The subset of {@link EmbeddedPiSubscribeContext} that the media-emission
 * tests actually populate.  Using this avoids the need for `as unknown as`
 * double-assertion in every mock factory.
 */
export type MockEmbeddedContext = Omit<EmbeddedPiSubscribeContext, "params"> & {
  params: TestParams;
};

/** Type-safe bridge: narrows parameter type so callers avoid assertions. */
function asFullContext(ctx: MockEmbeddedContext): EmbeddedPiSubscribeContext {
  return ctx as unknown as EmbeddedPiSubscribeContext;
}

/** Typed wrapper around {@link handleToolExecutionStart}. */
export function callToolExecutionStart(
  ctx: MockEmbeddedContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
): Promise<void> {
  return handleToolExecutionStart(asFullContext(ctx), evt);
}

/** Typed wrapper around {@link handleToolExecutionEnd}. */
export function callToolExecutionEnd(
  ctx: MockEmbeddedContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
  },
): Promise<void> {
  return handleToolExecutionEnd(asFullContext(ctx), evt);
}

/**
 * Check whether a mock-call argument is an object containing `mediaUrls`
 * but NOT `text` (i.e. a "direct media" emission).
 */
export function isDirectMediaCall(call: unknown[]): boolean {
  const arg = call[0];
  if (!arg || typeof arg !== "object") {
    return false;
  }
  return "mediaUrls" in arg && !("text" in arg);
}

/**
 * Filter a vi.fn() mock's call log to only direct-media emissions.
 */
export function filterDirectMediaCalls(mock: Mock): unknown[][] {
  return mock.mock.calls.filter(isDirectMediaCall);
}
