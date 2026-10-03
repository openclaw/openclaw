import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BROWSER_ACTION_TRANSPORT_SLACK_MS, resolveActWaitTimeoutMs } from "../act-policy.js";
import type { RelayCommandBody } from "./relay-protocol.js";

const EXTENSION_COMMAND_TIMEOUT_MS = 15_000;
// Promise-returning Runtime commands carry Playwright waits, whose public budget
// exceeds ordinary CDP round trips. Attachment abort and heartbeat still fence them.
const EXTENSION_AWAITED_RUNTIME_TIMEOUT_MS =
  resolveActWaitTimeoutMs(Number.MAX_SAFE_INTEGER) + BROWSER_ACTION_TRANSPORT_SLACK_MS;

export function resolveExtensionRelayCommandTimeoutMs(command: RelayCommandBody): number {
  return command.type === "cdp" &&
    (command.method === "Runtime.awaitPromise" ||
      ((command.method === "Runtime.evaluate" || command.method === "Runtime.callFunctionOn") &&
        asOptionalRecord(command.params)?.awaitPromise === true))
    ? EXTENSION_AWAITED_RUNTIME_TIMEOUT_MS
    : EXTENSION_COMMAND_TIMEOUT_MS;
}
