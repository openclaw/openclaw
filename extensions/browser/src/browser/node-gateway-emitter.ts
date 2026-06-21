/**
 * In-process registry for the node-attributed gateway-event emitter.
 *
 * The node-host owns `emitNodeGatewayEvent` (it originates events over this
 * node's authenticated gateway connection) and injects it here via the
 * `onNodeHostStart` hook. The bundled bridge (`server-lifecycle`) emits through
 * this registry, so the emitter is never exposed on the public plugin SDK
 * surface -- a third-party plugin cannot import it or forge node-attributed
 * events over the node connection.
 */
export type NodeGatewayEventEmitter = (event: string, payload: unknown) => Promise<void>;

let registeredEmitter: NodeGatewayEventEmitter | null = null;

/** Install the node-host's real emitter (called from the onNodeHostStart hook). */
export function setNodeGatewayEventEmitter(emitter: NodeGatewayEventEmitter | null): void {
  registeredEmitter = emitter;
}

/**
 * Originate a node-attributed gateway event. Throws if no node connection has
 * registered an emitter (e.g. a gateway-only deployment), which the bridge
 * surfaces to the side panel so it can fall back to a direct gateway turn.
 */
export async function emitNodeGatewayEvent(event: string, payload: unknown): Promise<void> {
  if (!registeredEmitter) {
    throw new Error("no node gateway-event emitter registered");
  }
  return registeredEmitter(event, payload);
}
