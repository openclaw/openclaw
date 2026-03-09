/**
 * Typed gRPC client factories for the SandboxService and ExecService.
 *
 * Creates nice-grpc clients with retry middleware for idempotent operations
 * (SandboxService) and plain clients for bidirectional streaming (ExecService).
 */

// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { createClientFactory, createClient, type Client } from "nice-grpc";
// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { deadlineMiddleware } from "nice-grpc-client-middleware-deadline";
// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { retryMiddleware } from "nice-grpc-client-middleware-retry";
// @ts-expect-error -- Generated proto code; available at runtime after buf generate
import { BrowserServiceDefinition } from "../proto/openclaw/sandbox/v1/browser.js";
// @ts-expect-error -- Generated proto code; available at runtime after buf generate
import { ExecServiceDefinition } from "../proto/openclaw/sandbox/v1/exec.js";
// @ts-expect-error -- Generated proto code; available at runtime after buf generate
import { FileServiceDefinition } from "../proto/openclaw/sandbox/v1/file.js";
// @ts-expect-error -- Generated proto code; available at runtime after buf generate
import { SandboxServiceDefinition } from "../proto/openclaw/sandbox/v1/sandbox.js";
import { getOrCreateChannel } from "./channel.js";

/**
 * Type alias for the SandboxService gRPC client with retry + deadline call options.
 */
export type SandboxClient = Client<typeof SandboxServiceDefinition>;

/**
 * Type alias for the ExecService gRPC client (bidi streaming, no retry middleware).
 */
export type ExecClient = Client<typeof ExecServiceDefinition>;

/**
 * Type alias for the FileService gRPC client (has streaming RPCs, no retry middleware).
 */
export type FileClient = Client<typeof FileServiceDefinition>;

/**
 * Type alias for the BrowserService gRPC client (has streaming RPCs, no retry middleware).
 */
export type BrowserClient = Client<typeof BrowserServiceDefinition>;

/**
 * Minimal gRPC health check v1 service definition for use with nice-grpc.
 * Follows the standard grpc.health.v1.Health protocol.
 */
const HealthDefinition = {
  name: "Health",
  fullName: "grpc.health.v1.Health",
  methods: {
    check: {
      name: "Check",
      requestType: {
        encode: (_msg: Record<string, unknown>) => ({ finish: () => new Uint8Array() }),
        decode: (_bytes: Uint8Array) => ({}),
        fromPartial: (_obj: unknown) => ({}),
      },
      requestStream: false as const,
      responseType: {
        encode: (_msg: Record<string, unknown>) => ({ finish: () => new Uint8Array() }),
        decode: (_bytes: Uint8Array) => ({ status: 0 }),
        fromPartial: (_obj: unknown) => ({ status: 0 }),
      },
      responseStream: false as const,
      options: {},
    },
  },
} as const;

/**
 * Create a typed SandboxService gRPC client with retry and deadline middleware.
 *
 * Retry middleware is attached for idempotent operations.
 * Per-call retry behavior can be controlled via call options:
 *   { retry: true, retryBaseDelayMs: 100, retryMaxDelayMs: 2000 }
 *
 * Deadline middleware allows setting per-call timeouts:
 *   { deadline: 5000 } // 5 seconds
 */
export function createSandboxClient(): SandboxClient {
  const channel = getOrCreateChannel();

  const factory = createClientFactory().use(retryMiddleware).use(deadlineMiddleware);

  return factory.create(SandboxServiceDefinition, channel);
}

/**
 * Create a typed ExecService gRPC client for bidirectional streaming.
 *
 * Does NOT use retry middleware -- bidi streaming retries are problematic.
 * Uses plain createClient for direct channel access.
 */
export function createExecClient(): ExecClient {
  const channel = getOrCreateChannel();
  return createClient(ExecServiceDefinition, channel);
}

/**
 * Create a typed FileService gRPC client for file operations.
 *
 * Does NOT use retry middleware -- FileService has streaming RPCs
 * (readFile is server-streaming, writeFile is client-streaming).
 * Uses plain createClient for direct channel access.
 */
export function createFileClient(): FileClient {
  const channel = getOrCreateChannel();
  return createClient(FileServiceDefinition, channel);
}

/**
 * Create a typed BrowserService gRPC client for browser automation.
 *
 * Does NOT use retry middleware -- BrowserService has a streaming RPC
 * (screenshot is server-streaming).
 * Uses plain createClient for direct channel access.
 */
export function createBrowserClient(): BrowserClient {
  const channel = getOrCreateChannel();
  return createClient(BrowserServiceDefinition, channel);
}

/**
 * Create a gRPC health check client for the vm-runner.
 * Used by checkFirecrackerHealth() to verify the service is serving.
 */
export function createHealthClient(): Client<typeof HealthDefinition> {
  const channel = getOrCreateChannel();
  return createClient(HealthDefinition, channel);
}
