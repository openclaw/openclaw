import type { Counter, Histogram, Meter } from "@opentelemetry/api";

export interface OtelMetricInstruments {
  tokensCounter: Counter;
  costCounter: Counter;
  durationHistogram: Histogram;
  contextHistogram: Histogram;
  webhookReceivedCounter: Counter;
  webhookErrorCounter: Counter;
  webhookDurationHistogram: Histogram;
  messageQueuedCounter: Counter;
  messageProcessedCounter: Counter;
  messageDurationHistogram: Histogram;
  queueDepthHistogram: Histogram;
  queueWaitHistogram: Histogram;
  laneEnqueueCounter: Counter;
  laneDequeueCounter: Counter;
  sessionStateCounter: Counter;
  sessionStuckCounter: Counter;
  sessionStuckAgeHistogram: Histogram;
  runAttemptCounter: Counter;
  genAiOperationDuration: Histogram;
  genAiTokenUsage: Histogram;
  genAiTtft: Histogram;
  inferenceErrorCounter: Counter;
}

export function createMetricInstruments(meter: Meter): OtelMetricInstruments {
  return {
    tokensCounter: meter.createCounter("openclaw.tokens", {
      unit: "1",
      description: "Token usage by type",
    }),
    costCounter: meter.createCounter("openclaw.cost.usd", {
      unit: "1",
      description: "Estimated model cost (USD)",
    }),
    durationHistogram: meter.createHistogram("openclaw.run.duration_ms", {
      unit: "ms",
      description: "Agent run duration",
    }),
    contextHistogram: meter.createHistogram("openclaw.context.tokens", {
      unit: "1",
      description: "Context window size and usage",
    }),
    webhookReceivedCounter: meter.createCounter("openclaw.webhook.received", {
      unit: "1",
      description: "Webhook requests received",
    }),
    webhookErrorCounter: meter.createCounter("openclaw.webhook.error", {
      unit: "1",
      description: "Webhook processing errors",
    }),
    webhookDurationHistogram: meter.createHistogram("openclaw.webhook.duration_ms", {
      unit: "ms",
      description: "Webhook processing duration",
    }),
    messageQueuedCounter: meter.createCounter("openclaw.message.queued", {
      unit: "1",
      description: "Messages queued for processing",
    }),
    messageProcessedCounter: meter.createCounter("openclaw.message.processed", {
      unit: "1",
      description: "Messages processed by outcome",
    }),
    messageDurationHistogram: meter.createHistogram("openclaw.message.duration_ms", {
      unit: "ms",
      description: "Message processing duration",
    }),
    queueDepthHistogram: meter.createHistogram("openclaw.queue.depth", {
      unit: "1",
      description: "Queue depth on enqueue/dequeue",
    }),
    queueWaitHistogram: meter.createHistogram("openclaw.queue.wait_ms", {
      unit: "ms",
      description: "Queue wait time before execution",
    }),
    laneEnqueueCounter: meter.createCounter("openclaw.queue.lane.enqueue", {
      unit: "1",
      description: "Command queue lane enqueue events",
    }),
    laneDequeueCounter: meter.createCounter("openclaw.queue.lane.dequeue", {
      unit: "1",
      description: "Command queue lane dequeue events",
    }),
    sessionStateCounter: meter.createCounter("openclaw.session.state", {
      unit: "1",
      description: "Session state transitions",
    }),
    sessionStuckCounter: meter.createCounter("openclaw.session.stuck", {
      unit: "1",
      description: "Sessions stuck in processing",
    }),
    sessionStuckAgeHistogram: meter.createHistogram("openclaw.session.stuck_age_ms", {
      unit: "ms",
      description: "Age of stuck sessions",
    }),
    runAttemptCounter: meter.createCounter("openclaw.run.attempt", {
      unit: "1",
      description: "Run attempts",
    }),
    genAiOperationDuration: meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "GenAI operation duration",
    }),
    genAiTokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "GenAI token usage",
    }),
    genAiTtft: meter.createHistogram("gen_ai.client.time_to_first_token", {
      unit: "s",
      description: "Time to first token from the model",
    }),
    inferenceErrorCounter: meter.createCounter("openclaw.inference.error", {
      unit: "1",
      description: "Model inference errors by type",
    }),
  };
}
