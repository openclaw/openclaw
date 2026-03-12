/**
 * gRPC channel factory for Unix socket communication with the vm-runner.
 *
 * Creates and caches a nice-grpc channel pointing at the vm-runner Unix
 * domain socket. The socket path is configurable via environment variable.
 */

// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { ChannelCredentials } from "@grpc/grpc-js";
// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { createChannel, type Channel } from "nice-grpc";

/**
 * Path to the vm-runner Unix domain socket.
 * Override via OPENCLAW_VM_RUNNER_SOCKET environment variable.
 */
export const VM_RUNNER_SOCKET: string =
  process.env.OPENCLAW_VM_RUNNER_SOCKET ?? "/var/run/openclaw-vm-runner.sock";

let cachedChannel: Channel = null as unknown as Channel;

/**
 * Get or create a cached gRPC channel to the vm-runner.
 *
 * The channel targets `unix:${VM_RUNNER_SOCKET}` with keepalive options
 * for resilient long-lived connections.
 */
export function getOrCreateChannel(): Channel {
  if (!cachedChannel) {
    cachedChannel = createChannel(`unix:${VM_RUNNER_SOCKET}`, ChannelCredentials.createInsecure(), {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 5_000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.initial_reconnect_backoff_ms": 100,
      "grpc.max_reconnect_backoff_ms": 10_000,
    });
  }
  return cachedChannel;
}

/**
 * Close and reset the cached channel.
 * The next call to getOrCreateChannel() will create a new channel.
 */
export function closeChannel(): void {
  if (cachedChannel) {
    cachedChannel.close();
    cachedChannel = null as unknown as Channel;
  }
}
