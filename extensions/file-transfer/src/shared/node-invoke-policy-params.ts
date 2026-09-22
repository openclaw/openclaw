import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { DIR_FETCH_DEFAULT_MAX_BYTES, DIR_FETCH_HARD_MAX_BYTES } from "./dir-fetch-limits.js";
import { readFileCreateMetadata } from "./file-create-protocol.js";
import {
  FILE_FETCH_DEFAULT_MAX_BYTES,
  FILE_FETCH_HARD_MAX_BYTES,
  readFileFetchBinaryMaxBytes,
} from "./file-fetch-protocol.js";
import type { FileTransferNodeInvokeCommand } from "./node-invoke-policy-commands.js";

function readMaxBytes(input: {
  value: unknown;
  defaultValue: number;
  hardMax: number;
  policyMax?: number;
}): number {
  const parsed =
    input.value === undefined
      ? input.defaultValue
      : readPositiveIntegerParam({ maxBytes: input.value }, "maxBytes");
  const requested = parsed ?? input.defaultValue;
  const clamped = Math.max(1, Math.min(requested, input.hardMax));
  return input.policyMax ? Math.min(clamped, input.policyMax) : clamped;
}

export function validateFetchMaxBytesParam(
  command: FileTransferNodeInvokeCommand,
  params: Record<string, unknown>,
) {
  if (command !== "file.fetch" && command !== "dir.fetch") {
    return;
  }
  if (params.maxBytes !== undefined) {
    readPositiveIntegerParam(params, "maxBytes");
  }
  if (command === "file.fetch") {
    readFileFetchBinaryMaxBytes(params);
  }
}

export function prepareParams(input: {
  command: FileTransferNodeInvokeCommand;
  params: Record<string, unknown>;
  followSymlinks: boolean;
  maxBytes?: number;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...input.params,
    // A caller may narrow the configured permission, never expand it.
    followSymlinks: input.followSymlinks && input.params.followSymlinks !== false,
  };
  delete next.preflightOnly;
  delete next.expectedCanonicalPath;
  delete next.expectedBinding;
  if (input.command === "file.create") {
    Object.assign(next, readFileCreateMetadata(input.params, input.maxBytes));
  } else if (input.command === "file.fetch") {
    const binaryMax = readFileFetchBinaryMaxBytes(input.params);
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: FILE_FETCH_DEFAULT_MAX_BYTES,
      hardMax: binaryMax ?? FILE_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  } else if (input.command === "dir.fetch") {
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
      hardMax: DIR_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  }
  return next;
}
