/** Configured-service identity, distinct from local executable attestation. */
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerRuntimeIdentity } from "./client.js";
import { codexAppServerStartOptionsKey } from "./config-runtime.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveCodexAppServerUnixSocketPath } from "./transport-websocket.js";

const CONNECTION_ID_PREFIX = "codex-app-server:connection:v1:";
const CONNECTION_HASH_DOMAIN = "openclaw-codex-configured-connection-v1\0";

export type CodexConfiguredConnectionCapture = Readonly<{
  kind: "configured-connection";
  transport: "websocket" | "unix";
  selectionFingerprint: string;
}>;

type CodexConfiguredConnectionDescriptor = CodexConfiguredConnectionCapture &
  Readonly<{ runtimeIdentityFingerprint: string }>;

export function captureCodexConfiguredConnection(
  start: CodexAppServerStartOptions,
): CodexConfiguredConnectionCapture {
  if (
    (start.transport !== "websocket" && start.transport !== "unix") ||
    (start.transport === "websocket" && !start.url?.trim())
  ) {
    throw new Error("Verified remote Codex inference requires a configured socket endpoint");
  }
  const unixSocketPath = resolveCodexAppServerUnixSocketPath(start);
  // Remote transports do not spawn command/argv. The canonical Unix endpoint
  // does consume home selection from env, so bind its resolved socket path.
  // Reuse the connection owner's credential hashing, then hide the whole key:
  // endpoint URLs can themselves contain credentials or private host names.
  const key = codexAppServerStartOptionsKey({
    transport: start.transport,
    command: "",
    args: [],
    url: unixSocketPath ? `unix://${path.resolve(unixSocketPath)}` : start.url,
    authToken: start.authToken,
    headers: start.headers,
  });
  return Object.freeze({
    kind: "configured-connection",
    transport: start.transport,
    selectionFingerprint: createHash("sha256").update(key).digest("hex"),
  });
}

export function finalizeCodexConfiguredConnection(params: {
  before: CodexConfiguredConnectionCapture;
  startOptions: CodexAppServerStartOptions;
  runtimeIdentity: CodexAppServerRuntimeIdentity | undefined;
}): AgentHarnessRuntimeArtifactBinding {
  const after = captureCodexConfiguredConnection(params.startOptions);
  if (JSON.stringify(after) !== JSON.stringify(params.before)) {
    throw new Error("Codex configured connection changed during startup");
  }
  const serverVersion = params.runtimeIdentity?.serverVersion?.trim();
  if (!serverVersion) {
    throw new Error("Codex app-server did not report an initialized runtime identity");
  }
  const descriptor: CodexConfiguredConnectionDescriptor = {
    ...after,
    runtimeIdentityFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          serverVersion,
          userAgent: params.runtimeIdentity?.userAgent ?? null,
          codexHome: params.runtimeIdentity?.codexHome ?? null,
          platformFamily: params.runtimeIdentity?.platformFamily ?? null,
          platformOs: params.runtimeIdentity?.platformOs ?? null,
        }),
      )
      .digest("hex"),
  };
  return Object.freeze({
    id: encodeConnectionId(descriptor),
    fingerprint: fingerprint(descriptor),
  });
}

export function isCodexConfiguredConnectionArtifact(id: string): boolean {
  return id.startsWith(CONNECTION_ID_PREFIX);
}

export function validateCodexConfiguredConnectionCapture(
  binding: AgentHarnessRuntimeArtifactBinding,
  capture: CodexConfiguredConnectionCapture,
): boolean {
  try {
    const descriptor = decodeConnectionId(binding.id);
    return (
      descriptor.transport === capture.transport &&
      descriptor.selectionFingerprint === capture.selectionFingerprint &&
      binding.fingerprint === fingerprint(descriptor)
    );
  } catch {
    return false;
  }
}

function encodeConnectionId(descriptor: CodexConfiguredConnectionDescriptor): string {
  return `${CONNECTION_ID_PREFIX}${Buffer.from(JSON.stringify(descriptor)).toString("base64url")}`;
}

function fingerprint(descriptor: CodexConfiguredConnectionDescriptor): string {
  return createHash("sha256")
    .update(CONNECTION_HASH_DOMAIN)
    .update(JSON.stringify(descriptor))
    .digest("hex");
}

function decodeConnectionId(id: string): CodexConfiguredConnectionDescriptor {
  if (!isCodexConfiguredConnectionArtifact(id) || Buffer.byteLength(id) > 2048) {
    throw new Error("Invalid Codex configured connection artifact");
  }
  const value: unknown = JSON.parse(
    Buffer.from(id.slice(CONNECTION_ID_PREFIX.length), "base64url").toString("utf8"),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    value.kind !== "configured-connection" ||
    !("transport" in value) ||
    (value.transport !== "websocket" && value.transport !== "unix") ||
    !("selectionFingerprint" in value) ||
    typeof value.selectionFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.selectionFingerprint) ||
    !("runtimeIdentityFingerprint" in value) ||
    typeof value.runtimeIdentityFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.runtimeIdentityFingerprint)
  ) {
    throw new Error("Invalid Codex configured connection descriptor");
  }
  const descriptor: CodexConfiguredConnectionDescriptor = {
    kind: value.kind,
    transport: value.transport,
    selectionFingerprint: value.selectionFingerprint,
    runtimeIdentityFingerprint: value.runtimeIdentityFingerprint,
  };
  if (encodeConnectionId(descriptor) !== id) {
    throw new Error("Invalid noncanonical Codex configured connection artifact");
  }
  return descriptor;
}
