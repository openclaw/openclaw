import type { VaultAccess } from "./access.js";

// Messages between the main thread (StorageClient) and the storage worker; `Op` is
// the storage operation name, narrowed by the host's operation table.
export type HostMessage<Op extends string = string> = {
  type: "call";
  id: number;
  op: Op;
  input: unknown;
  scope: VaultAccess["scope"];
  agentId: string;
  activity?: VaultAccess["activity"];
};
export type WorkerMessage =
  | { type: "assert"; id: number }
  | { type: "done"; id: number; ok: true; value: unknown }
  | { type: "done"; id: number; ok: false; message: string };
/** Error thrown in the worker when the main thread reports lost authority; the
 * client replaces it with the main thread's original error. */
export const AUTHORITY_REVOKED = "Knowledge authority changed during the operation.";
