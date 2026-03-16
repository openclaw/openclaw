import { Kafka, logLevel, type Producer } from "kafkajs";
import type { ProbeEvent, ResolvedProbeConfig } from "../types.js";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface KafkaWriterHandle {
  enqueue(event: ProbeEvent): void;
  stop(): Promise<void>;
}

export async function startKafkaWriter(
  config: ResolvedProbeConfig,
  logger: Logger,
): Promise<KafkaWriterHandle> {
  const kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    logLevel: logLevel.NOTHING,
  });

  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();

  logger.info(
    `gateway-probe: kafka producer connected (brokers=${config.kafka.brokers.join(",")}, topic=${config.kafka.topic})`,
  );

  const state = {
    queue: [] as ProbeEvent[],
    dropped: 0,
    flushing: false,
    stopped: false,
  };

  let flushPromise: Promise<void> | null = null;

  async function flushBatch(p: Producer): Promise<boolean> {
    if (state.flushing || state.queue.length === 0) {
      return true;
    }

    state.flushing = true;

    const batch = state.queue.splice(0, config.kafka.batchMaxSize);

    try {
      await p.send({
        topic: config.kafka.topic,
        messages: batch.map((event) => ({
          key: event.sessionId ?? event.sessionKey ?? event.probeId,
          value: JSON.stringify(event),
        })),
      });
      return true;
    } catch (err) {
      // Requeue on send failure; oldest entries are dropped if queue is already at cap.
      state.queue.unshift(...batch);
      if (state.queue.length > config.kafka.maxQueueSize) {
        const overflow = state.queue.length - config.kafka.maxQueueSize;
        state.queue.splice(0, overflow);
        state.dropped += overflow;
        logger.warn(
          `gateway-probe: dropped ${overflow} queued events after send failure (queue cap=${config.kafka.maxQueueSize})`,
        );
      }

      logger.error(
        `gateway-probe: kafka send failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return false;
    } finally {
      state.flushing = false;
    }
  }

  async function flushLoop(forceAll: boolean): Promise<void> {
    if (flushPromise) {
      await flushPromise;
      return;
    }

    flushPromise = (async () => {
      do {
        const sent = await flushBatch(producer);
        if (forceAll && !sent) {
          break;
        }
      } while (forceAll && state.queue.length > 0);
    })();

    try {
      await flushPromise;
    } finally {
      flushPromise = null;
    }
  }

  const timer = setInterval(() => {
    if (state.stopped) {
      return;
    }
    void flushLoop(false);
  }, config.kafka.flushIntervalMs);
  timer.unref?.();

  return {
    enqueue(event: ProbeEvent) {
      if (state.stopped) {
        return;
      }

      if (state.queue.length >= config.kafka.maxQueueSize) {
        state.queue.shift();
        state.dropped += 1;
        if (state.dropped === 1 || state.dropped % 100 === 0) {
          logger.warn(
            `gateway-probe: dropped ${state.dropped} total events because queue is full (maxQueueSize=${config.kafka.maxQueueSize})`,
          );
        }
      }

      state.queue.push(event);
      if (state.queue.length >= config.kafka.batchMaxSize) {
        void flushLoop(false);
      }
    },

    async stop() {
      state.stopped = true;
      clearInterval(timer);

      await flushLoop(true);
      if (state.queue.length > 0) {
        logger.warn(`gateway-probe: dropping ${state.queue.length} unsent events during shutdown`);
        state.queue.length = 0;
      }
      await producer.disconnect().catch((err: unknown) => {
        logger.error(
          `gateway-probe: kafka disconnect failed (${err instanceof Error ? err.message : String(err)})`,
        );
      });
    },
  };
}
