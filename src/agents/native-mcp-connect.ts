import { SdkError, SdkErrorCode, type Transport } from "@modelcontextprotocol/client";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";

type NativeMcpProbe = {
  canRestartLegacy(error: unknown): boolean;
  detach(): void;
};

/** Observe the one disposable legacy probe without changing SDK negotiation policy. */
export function observeNativeMcpProbe(transport: OpenClawStdioClientTransport): NativeMcpProbe;
export function observeNativeMcpProbe(transport: Transport): NativeMcpProbe | undefined;
export function observeNativeMcpProbe(transport: Transport): NativeMcpProbe | undefined {
  if (!(transport instanceof OpenClawStdioClientTransport)) {
    return undefined;
  }
  let closeRequested = false;
  let spontaneousExit = false;
  let failedIo = false;
  let observing = true;
  const methods: {
    close: (this: OpenClawStdioClientTransport) => ReturnType<Transport["close"]>;
    send: (
      this: OpenClawStdioClientTransport,
      ...args: Parameters<Transport["send"]>
    ) => ReturnType<Transport["send"]>;
  } = transport;
  const originalClose = methods.close;
  const originalSend = methods.send;
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
  const onexit = () => {
    if (observing) {
      spontaneousExit = !closeRequested;
    }
  };
  const onerror = () => {
    if (observing) {
      failedIo = true;
    }
  };
  transport.close = close;
  transport.send = send;
  transport.addEventListener("exit", onexit);
  transport.addEventListener("error", onerror);
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
      // Protocol.connect may retain the send wrapper in its own handlers.
      observing = false;
      if (transport.close === close) {
        transport.close = originalClose;
      }
      if (transport.send === send) {
        transport.send = originalSend;
      }
      transport.removeEventListener("exit", onexit);
      transport.removeEventListener("error", onerror);
    },
  };
}
