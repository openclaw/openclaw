// Real-SDK reproducer for non-finite OTLP duration configuration: the value
// must warn and fall back instead of reaching a timer that overflows to 1 ms.
// Oracle: docs/gateway/opentelemetry/configuration.md requires a positive
// number for the BSP and metric interval/timeout settings; invalid values fall
// back to the OpenTelemetry defaults.
import { diag, DiagLogLevel } from "@opentelemetry/api";
import * as otelCore from "@opentelemetry/core";
import { afterEach, expect, test } from "vitest";
import { startOtelService, startOtlpReceiver } from "./service.test-helpers.js";

const ENV_KEYS = [
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_TIMEOUT",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_BSP_EXPORT_TIMEOUT",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let overflow: string[] = [];
const onWarning = (warning: Error) => {
  if (warning.name === "TimeoutOverflowWarning") {
    overflow.push(warning.message);
  }
};

afterEach(() => {
  process.off("warning", onWarning);
  diag.disable();
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

async function observe(interval: string) {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.OTEL_METRIC_EXPORT_INTERVAL = interval;
  const diagnostics: string[] = [];
  diag.setLogger(
    {
      debug: () => {},
      error: (message) => diagnostics.push(String(message)),
      info: () => {},
      verbose: () => {},
      warn: (message) => diagnostics.push(String(message)),
    },
    { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true },
  );
  overflow = [];
  process.on("warning", onWarning);
  const receiver = await startOtlpReceiver();
  const { service, ctx } = await startOtelService({
    endpoint: receiver.endpoint,
    traces: false,
    metrics: true,
  });
  try {
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    return {
      parsed: otelCore.getNumberFromEnv("OTEL_METRIC_EXPORT_INTERVAL"),
      invalid: diagnostics.filter((message) => message.includes("is invalid")),
      overflow: [...overflow],
      requests: receiver.requests.length,
    };
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
}

test("1e309 must warn and fall back instead of a 1ms export loop", async () => {
  const observed = await observe("1e309");
  expect(observed.parsed).toBe(Number.POSITIVE_INFINITY);
  expect(observed.invalid).toHaveLength(1);
  expect(observed.overflow).toHaveLength(0);
  expect(observed.requests).toBe(0);
}, 30_000);

test("control: 0 warns and falls back without an overflow loop", async () => {
  const observed = await observe("0");
  expect(observed.invalid).toHaveLength(1);
  expect(observed.overflow).toHaveLength(0);
  expect(observed.requests).toBe(0);
}, 30_000);
