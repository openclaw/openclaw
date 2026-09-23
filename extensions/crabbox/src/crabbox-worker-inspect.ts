import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { nonEmptyString } from "./crabbox-worker-profile.js";

type CrabboxInspect = {
  failureError?: unknown;
  id?: unknown;
  providerMetadata?: unknown;
  ready?: unknown;
  sshUser?: unknown;
  state?: unknown;
  tailscale?: unknown;
};

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
  let value: CrabboxInspect;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("inspect output is not an object");
    }
    value = parsed as CrabboxInspect;
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
  if (
    value.tailscale !== undefined &&
    (value.tailscale === null ||
      typeof value.tailscale !== "object" ||
      Array.isArray(value.tailscale))
  ) {
    throw new Error("Crabbox inspect returned invalid Tailscale state");
  }
  const tailscaleEnabled = value.tailscale !== undefined;
  let awsInstanceProfileAttached: boolean | undefined;
  if (value.providerMetadata !== undefined) {
    if (
      value.providerMetadata === null ||
      typeof value.providerMetadata !== "object" ||
      Array.isArray(value.providerMetadata)
    ) {
      throw new Error("Crabbox inspect returned invalid provider metadata");
    }
    const attached = (value.providerMetadata as Record<string, unknown>)["instanceProfileAttached"];
    if (attached !== undefined && typeof attached !== "boolean") {
      throw new Error("Crabbox inspect returned invalid AWS instance profile metadata");
    }
    awsInstanceProfileAttached = attached as boolean | undefined;
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
