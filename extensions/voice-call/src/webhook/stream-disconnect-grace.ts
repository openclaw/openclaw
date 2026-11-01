const STREAM_DISCONNECT_GRACE_MS = 2_000;

type StreamState = {
  streamId: string;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

/** Track the current carrier stream and expire disconnected calls after reconnect grace. */
export class StreamDisconnectGrace {
  private readonly streams = new Map<string, StreamState>();

  constructor(
    private readonly onGraceExpired: (stream: { providerCallId: string; streamId: string }) => void,
  ) {}

  connect(providerCallId: string, streamId: string): void {
    const current = this.streams.get(providerCallId);
    if (current?.disconnectTimer) {
      clearTimeout(current.disconnectTimer);
    }
    this.streams.set(providerCallId, { streamId });
  }

  disconnect(providerCallId: string, streamId: string): void {
    const current = this.streams.get(providerCallId);
    if (!current || current.streamId !== streamId || current.disconnectTimer) {
      return;
    }

    current.disconnectTimer = setTimeout(() => {
      this.streams.delete(providerCallId);
      this.onGraceExpired({ providerCallId, streamId });
    }, STREAM_DISCONNECT_GRACE_MS).unref();
  }

  retire(providerCallId: string, streamId: string): void {
    const current = this.streams.get(providerCallId);
    if (!current || current.streamId !== streamId) {
      return;
    }
    if (current.disconnectTimer) {
      clearTimeout(current.disconnectTimer);
    }
    this.streams.delete(providerCallId);
  }

  close(): void {
    for (const state of this.streams.values()) {
      if (state.disconnectTimer) {
        clearTimeout(state.disconnectTimer);
      }
    }
    this.streams.clear();
  }
}
