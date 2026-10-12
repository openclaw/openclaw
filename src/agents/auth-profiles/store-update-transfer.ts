import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { createJsonFieldReceiver, jsonFieldBatches } from "../../infra/json-field-transfer.js";
import { cloneAuthProfileJsonValue } from "./clone-value.js";

export function sendAuthProfileUpdateValue(port: MessagePort, value: unknown): void {
  for (const batch of jsonFieldBatches(cloneAuthProfileJsonValue(value))) {
    port.postMessage(batch);
  }
}

/** The producer queues a complete value before requesting its host admission. */
export function receiveAuthProfileUpdateValue(port: MessagePort): unknown {
  const receiver = createJsonFieldReceiver();
  for (let message = receiveMessageOnPort(port); message; message = receiveMessageOnPort(port)) {
    if (!Array.isArray(message.message)) {
      throw new Error("Invalid auth profile field batch");
    }
    for (const field of message.message) {
      receiver.accept(field);
    }
  }
  return receiver.finish();
}
