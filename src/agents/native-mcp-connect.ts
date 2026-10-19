import { SdkError, SdkErrorCode, type Transport } from "@modelcontextprotocol/client";
import type { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";

/** Observe the one disposable legacy probe without changing SDK negotiation policy. */
export function observeNativeMcpProbe(transport: OpenClawStdioClientTransport) {
  let closeRequested = false;
  let spontaneousExit = false;
  let failedIo = false;
  let observing = true;
  // oxlint-disable-next-line typescript/unbound-method -- Preserve identity for restoration; call with the transport receiver.
  const originalClose = transport.close;
  // oxlint-disable-next-line typescript/unbound-method -- Preserve identity for restoration; call with the transport receiver.
  const originalSend: Transport["send"] = transport.send;
  const originalExit = transport.onexit;
  const originalError = transport.onerror;
  const close: typeof transport.close = function () {
    if (observing) {
      closeRequested = true;
    }
    return originalClose.call(transport);
  };
  const send: Transport["send"] = async function (message, options) {
    try {
      await originalSend.call(transport, message, options);
    } catch (error) {
      if (observing) {
        failedIo = true;
      }
      throw error;
    }
  };
  const onexit: NonNullable<typeof transport.onexit> = (exit) => {
    if (observing) {
      spontaneousExit = !closeRequested;
    }
    originalExit?.call(transport, exit);
  };
  const onerror: NonNullable<typeof transport.onerror> = (error) => {
    if (observing) {
      failedIo = true;
    }
    originalError?.call(transport, error);
  };
  transport.close = close;
  transport.send = send;
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports are not EventTargets.
  transport.onexit = onexit;
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports are not EventTargets.
  transport.onerror = onerror;
  return {
    canRestartLegacy(error: unknown): boolean {
      // Custom stdio transports probe in place. An unrecognized pre-initialize
      // request may exit the child; cleanup-triggered exits are not era evidence.
      return (
        error instanceof SdkError &&
        error.code === SdkErrorCode.EraNegotiationFailed &&
        spontaneousExit &&
        !failedIo
      );
    },
    detach(): void {
      // Protocol.connect may have chained these callbacks into its own handlers.
      observing = false;
      if (transport.close === close) {
        transport.close = originalClose;
      }
      if (transport.send === send) {
        transport.send = originalSend;
      }
      if (transport.onexit === onexit) {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports are not EventTargets.
        transport.onexit = originalExit;
      }
      if (transport.onerror === onerror) {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports are not EventTargets.
        transport.onerror = originalError;
      }
    },
  };
}
