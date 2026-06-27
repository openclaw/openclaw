// WhatsApp plugin module stores process-local monitor runtime overrides.
import type { WhatsAppCreateSocket } from "./connection-controller.js";

export type { WhatsAppCreateSocket, WhatsAppSocket } from "./connection-controller.js";

export type WhatsAppMonitorRuntimeOptions = {
  createSocket?: WhatsAppCreateSocket;
};

type WhatsAppMonitorRuntimeOptionsState = {
  options: WhatsAppMonitorRuntimeOptions;
};

const WHATSAPP_MONITOR_RUNTIME_OPTIONS_KEY = Symbol.for("openclaw.whatsapp.monitorRuntimeOptions");

function getWhatsAppMonitorRuntimeOptionsState(): WhatsAppMonitorRuntimeOptionsState {
  const globalState = globalThis as typeof globalThis & {
    [WHATSAPP_MONITOR_RUNTIME_OPTIONS_KEY]?: WhatsAppMonitorRuntimeOptionsState;
  };
  const existing = globalState[WHATSAPP_MONITOR_RUNTIME_OPTIONS_KEY];
  if (existing) {
    return existing;
  }
  const created: WhatsAppMonitorRuntimeOptionsState = { options: {} };
  globalState[WHATSAPP_MONITOR_RUNTIME_OPTIONS_KEY] = created;
  return created;
}

export function setWhatsAppMonitorRuntimeOptions(options?: WhatsAppMonitorRuntimeOptions): void {
  getWhatsAppMonitorRuntimeOptionsState().options = options?.createSocket
    ? { createSocket: options.createSocket }
    : {};
}

export function getWhatsAppMonitorRuntimeOptions(): WhatsAppMonitorRuntimeOptions {
  return { ...getWhatsAppMonitorRuntimeOptionsState().options };
}
