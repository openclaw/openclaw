import { EventEmitter } from "node:events";
import type { XmppInboundMessage } from "./types.js";

/**
 * XmppRuntime manages the lifecycle and event distribution for the XMPP channel.
 * It acts as a singleton event bus for XMPP client events.
 */
export class XmppRuntime extends EventEmitter {
  private static instance: XmppRuntime;

  private constructor() {
    super();
  }

  public static getInstance(): XmppRuntime {
    if (!XmppRuntime.instance) {
      XmppRuntime.instance = new XmppRuntime();
    }
    return XmppRuntime.instance;
  }

  /**
   * Emit an inbound message event.
   */
  public emitMessage(message: XmppInboundMessage) {
    this.emit("message", message);
  }

  /**
   * Subscribe to inbound message events.
   */
  public onMessage(listener: (message: XmppInboundMessage) => void) {
    this.on("message", listener);
  }
}

export function getXmppRuntime(): XmppRuntime {
  return XmppRuntime.getInstance();
}
