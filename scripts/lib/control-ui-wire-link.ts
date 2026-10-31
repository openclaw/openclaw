import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";

type Flow = {
  source: Readable;
  target: Writable;
  chunk?: Buffer;
  offset: number;
  receivedAtMs: number;
  pending: number;
  queued: boolean;
  blocked: boolean;
  ended: boolean;
  closed: boolean;
  stop: () => void;
  transmit: (chunk: Buffer, deliveredAtMs: number, receivedAtMs: number) => void;
};

/** One shared direction; propagation overlaps later packet transmission. */
export function createControlUiWireLink({
  megabitsPerSecond = 10,
  latencyMs = 50,
}: { megabitsPerSecond?: number; latencyMs?: number } = {}) {
  if (
    !Number.isFinite(megabitsPerSecond) ||
    megabitsPerSecond <= 0 ||
    !Number.isFinite(latencyMs) ||
    latencyMs < 0
  ) {
    throw new Error("Wire link requires positive bandwidth and nonnegative latency");
  }
  const quantumBytes = 16 * 1024;
  const bytesPerMs = (megabitsPerSecond * 1_000_000) / 8 / 1000;
  const flows = new Set<Flow>();
  const ready: Flow[] = [];
  const deliveries = new Set<ReturnType<typeof setTimeout>>();
  let transmitting: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const finish = (flow: Flow) => {
    if (!flow.closed && flow.ended && !flow.chunk && flow.pending === 0) {
      flow.target.end();
    }
  };
  const enqueue = (flow: Flow) => {
    if (!flow.closed && !flow.blocked && flow.chunk && !flow.queued) {
      flow.queued = true;
      ready.push(flow);
    }
    pump();
  };
  const pump = () => {
    if (closed || transmitting !== undefined) {
      return;
    }
    let flow: Flow | undefined;
    while ((flow = ready.shift())) {
      flow.queued = false;
      if (!flow.closed && !flow.blocked && flow.chunk && !flow.target.destroyed) {
        break;
      }
    }
    if (!flow?.chunk) {
      return;
    }
    const selected = flow;
    const end = Math.min(selected.offset + quantumBytes, flow.chunk.length);
    const packet = flow.chunk.subarray(selected.offset, end);
    const serializedAtMs = performance.now() + packet.length / bytesPerMs;
    const deliveredAtMs = serializedAtMs + latencyMs;
    selected.pending++;
    selected.transmit(packet, deliveredAtMs, selected.receivedAtMs);
    const delivery = setTimeout(
      () => {
        deliveries.delete(delivery);
        selected.pending--;
        if (!selected.closed && !selected.target.destroyed) {
          if (!selected.target.write(packet)) {
            selected.blocked = true;
            selected.source.pause();
          }
          finish(selected);
        }
      },
      Math.ceil(deliveredAtMs - performance.now()),
    );
    deliveries.add(delivery);
    transmitting = setTimeout(
      () => {
        transmitting = undefined;
        if (!selected.closed) {
          selected.offset = end;
          if (selected.offset === selected.chunk?.length) {
            selected.chunk = undefined;
            selected.offset = 0;
            if (!selected.blocked && !selected.ended) {
              selected.source.resume();
            }
            finish(selected);
          } else {
            enqueue(selected);
          }
        }
        pump();
      },
      Math.ceil(serializedAtMs - performance.now()),
    );
  };

  return {
    connect(source: Readable, target: Writable, onTransmit: Flow["transmit"]): () => void {
      if (closed) {
        throw new Error("Control UI wire link is closed");
      }
      const flow: Flow = {
        source,
        target,
        offset: 0,
        receivedAtMs: 0,
        pending: 0,
        queued: false,
        blocked: false,
        ended: false,
        closed: false,
        stop,
        transmit: onTransmit,
      };
      function dispose(destroySource: boolean) {
        if (flow.closed) {
          return;
        }
        flow.closed = true;
        flow.chunk = undefined;
        flows.delete(flow);
        source.off("data", data);
        source.off("end", end);
        source.off("close", sourceClose);
        source.off("error", stop);
        target.off("drain", drain);
        target.off("close", targetClose);
        target.off("error", stop);
        if (destroySource) {
          source.destroy();
        }
        target.destroy();
      }
      function stop() {
        dispose(true);
      }
      function targetClose() {
        // After a clean half-close, the reverse link still owns response delivery.
        dispose(!flow.ended);
      }
      function data(chunk: Buffer) {
        source.pause();
        flow.chunk = chunk;
        flow.receivedAtMs = performance.now();
        enqueue(flow);
      }
      function end() {
        flow.ended = true;
        finish(flow);
      }
      function sourceClose() {
        if (!flow.ended) {
          stop();
        }
      }
      function drain() {
        flow.blocked = false;
        if (flow.chunk) {
          enqueue(flow);
        } else if (!flow.ended) {
          source.resume();
        }
      }
      flows.add(flow);
      source.on("data", data);
      source.on("end", end);
      source.on("close", sourceClose);
      source.on("error", stop);
      target.on("drain", drain);
      target.on("close", targetClose);
      target.on("error", stop);
      return stop;
    },
    close() {
      closed = true;
      clearTimeout(transmitting);
      transmitting = undefined;
      deliveries.forEach(clearTimeout);
      deliveries.clear();
      flows.forEach((flow) => flow.stop());
      ready.length = 0;
    },
  };
}
