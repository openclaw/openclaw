import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryState = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  close: vi.fn().mockResolvedValue(true),
}));

vi.mock("@sentry/node", () => ({
  init: sentryState.init,
  captureException: sentryState.captureException,
  close: sentryState.close,
}));

import type { OpenClawPluginServiceContext } from "../api.js";
import { emitDiagnosticEvent } from "../api.js";
import { createDiagnosticsSentryService, parseDiagnosticsSentryConfig } from "./service.js";

function createContext(): OpenClawPluginServiceContext {
  return {
    config: {},
    stateDir: "/tmp/openclaw-diagnostics-sentry-test",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("diagnostics-sentry service", () => {
  beforeEach(() => {
    sentryState.init.mockClear();
    sentryState.captureException.mockClear();
    sentryState.close.mockClear();
  });

  it("normalizes plugin config safely", () => {
    expect(
      parseDiagnosticsSentryConfig({ enabled: true, dsn: " https://dsn ", flushTimeoutMs: 900 }),
    ).toEqual({
      enabled: true,
      dsn: "https://dsn",
      environment: undefined,
      release: undefined,
      serverName: undefined,
      flushTimeoutMs: 900,
    });
  });

  it("captures cron failures and ignores successful runs", async () => {
    const ctx = createContext();
    const service = createDiagnosticsSentryService({
      enabled: true,
      dsn: "https://dsn.ingest.sentry.io/1",
    });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "cron.finished",
      jobId: "job-ok",
      jobName: "Healthy job",
      status: "ok",
    });
    emitDiagnosticEvent({
      type: "cron.finished",
      jobId: "job-fail",
      jobName: "Broken job",
      status: "error",
      error: "boom",
      deliveryStatus: "not-delivered",
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(sentryState.init).toHaveBeenCalledTimes(1);
    expect(sentryState.captureException).toHaveBeenCalledTimes(1);
    const captureArgs = sentryState.captureException.mock.calls[0];
    expect(captureArgs?.[0]).toBeInstanceOf(Error);
    expect(captureArgs?.[1]).toMatchObject({
      tags: {
        subsystem: "cron",
        job_id: "job-fail",
        job_name: "Broken job",
        delivery_status: "not-delivered",
      },
    });

    await service.stop?.(ctx);
    expect(sentryState.close).toHaveBeenCalledTimes(1);
  });
});
