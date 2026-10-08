import type { AgentMessage } from "../../runtime/index.js";
import type { RunEmbeddedAgentParams } from "./params.js";

/** The admitted native turn adds correlation only to the protected transcript envelope. */
export function attachNativeInboundTransportForPersistence(
  message: Extract<AgentMessage, { role: "user" }>,
  transport: NonNullable<RunEmbeddedAgentParams["inboundTransport"]>,
): void {
  // SAFETY: AgentMessage user records may carry the host-owned protected metadata envelope.
  const metadata = (message as { __openclaw?: Record<string, unknown> })["__openclaw"];
  const existingTransport = metadata?.transport;
  Object.assign(message, {
    __openclaw: {
      ...metadata,
      transport: {
        ...(existingTransport && typeof existingTransport === "object" ? existingTransport : {}),
        ...transport,
      },
    },
  });
}
