import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  isRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export type ParsedInspect = {
  awsInstanceProfileAttached?: boolean;
  failureError?: string;
  id: string;
  ready?: boolean;
  sshUser?: string;
  state: string;
  tailscaleEnabled: boolean;
};

export function parseInspectJson(stdout: string): ParsedInspect {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      throw new Error("inspect output is not an object");
    }
    value = parsed;
  } catch {
    throw new Error("Crabbox inspect returned invalid JSON");
  }

  const id = nonEmptyString(value.id);
  const state = nonEmptyString(value.state)?.toLowerCase();
  if (!id || !/^\S{1,128}$/u.test(id) || !state) {
    throw new Error("Crabbox inspect returned an invalid lease identity or state");
  }
  if (value.ready !== undefined && typeof value.ready !== "boolean") {
    throw new Error("Crabbox inspect returned an invalid ready state");
  }
  if (value.sshUser !== undefined && typeof value.sshUser !== "string") {
    throw new Error("Crabbox inspect returned an invalid SSH user");
  }
  const sshUser = nonEmptyString(value.sshUser);
  if (value.tailscale !== undefined && !isRecord(value.tailscale)) {
    throw new Error("Crabbox inspect returned invalid Tailscale state");
  }
  const tailscaleEnabled = value.tailscale !== undefined;
  let awsInstanceProfileAttached: boolean | undefined;
  if (value.providerMetadata !== undefined) {
    if (!isRecord(value.providerMetadata)) {
      throw new Error("Crabbox inspect returned invalid provider metadata");
    }
    const attached = value.providerMetadata.instanceProfileAttached;
    if (attached !== undefined && typeof attached !== "boolean") {
      throw new Error("Crabbox inspect returned invalid AWS instance profile metadata");
    }
    awsInstanceProfileAttached = attached;
  }

  const failureError = nonEmptyString(value.failureError);
  return {
    id,
    state,
    tailscaleEnabled,
    ...(failureError
      ? {
          failureError: truncateUtf16Safe(
            redactSensitiveText(failureError).replace(/\s+/gu, " "),
            512,
          ),
        }
      : {}),
    ...(awsInstanceProfileAttached !== undefined ? { awsInstanceProfileAttached } : {}),
    ...(typeof value.ready === "boolean" ? { ready: value.ready } : {}),
    ...(sshUser && sshUser !== "<token>" ? { sshUser } : {}),
  };
}
