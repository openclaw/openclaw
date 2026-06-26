// Qa Matrix plugin module implements live transport artifact behavior.
import { randomUUID } from "node:crypto";

export function createLiveTransportQaRunId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
