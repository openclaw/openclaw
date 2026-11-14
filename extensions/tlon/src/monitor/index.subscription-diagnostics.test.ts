import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { expect, it, vi } from "vitest";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const { authenticateMock, getSubscription, withMonitor } = useTlonMonitorFixture();

it("reports subscription diagnostics through the current monitor runtime", async () => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");

  await withMonitor(async (runtime) => {
    const errors = vi.fn(function (this: RuntimeEnv) {
      expect(this).toBe(runtime);
    });
    const logs = vi.fn(function (this: RuntimeEnv) {
      expect(this).toBe(runtime);
    });
    runtime.error = errors;
    runtime.log = logs;
    const diagnostics = [
      [
        "channels",
        "/v2",
        "[tlon] Channels firehose error: Error: diagnostic fixture",
        "[tlon] Channels firehose subscription ended",
      ],
      [
        "chat",
        "/v3",
        "[tlon] Chat firehose error: Error: diagnostic fixture",
        "[tlon] Chat firehose subscription ended",
      ],
      [
        "contacts",
        "/v1/news",
        "[tlon] Contacts subscription error: Error: diagnostic fixture",
        "[tlon] Contacts subscription ended",
      ],
      [
        "groups",
        "/groups/ui",
        "[tlon] Groups-ui subscription error: Error: diagnostic fixture",
        "[tlon] Groups-ui subscription ended",
      ],
      [
        "groups",
        "/v1/foreigns",
        "[tlon] Foreigns subscription error: Error: diagnostic fixture",
        "[tlon] Foreigns subscription ended",
      ],
    ] as const;
    for (const [app, path] of diagnostics) {
      const subscription = getSubscription(app, path);
      subscription.err(new Error("diagnostic fixture"));
      subscription.quit();
    }
    expect(errors.mock.calls).toEqual(diagnostics.map((row) => [row[2]]));
    expect(logs.mock.calls).toEqual(diagnostics.map((row) => [row[3]]));
  });
});
