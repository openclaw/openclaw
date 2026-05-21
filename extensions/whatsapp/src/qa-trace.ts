import { appendFile } from "node:fs/promises";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";

const WHATSAPP_QA_TRACE_ENV = "OPENCLAW_QA_WHATSAPP_TRACE";
const WHATSAPP_QA_TRACE_PATH_ENV = "OPENCLAW_QA_WHATSAPP_TRACE_PATH";

function isWhatsAppQaTraceEnabled(): boolean {
  const value = process.env[WHATSAPP_QA_TRACE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function traceWhatsAppQaEvent(event: Record<string, unknown>): void {
  const tracePath = process.env[WHATSAPP_QA_TRACE_PATH_ENV]?.trim();
  if (!tracePath && !isWhatsAppQaTraceEnabled()) {
    return;
  }
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  if (tracePath) {
    void appendFile(tracePath, line).catch((error) => {
      defaultRuntime.log(`Failed to write WhatsApp QA trace: ${String(error)}`);
    });
  }
  if (isWhatsAppQaTraceEnabled()) {
    defaultRuntime.log(`[whatsapp-qa-trace] ${line.trimEnd()}`);
  }
}
