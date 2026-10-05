import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import {
  createCrabboxProvisionTelemetry,
  createCrabboxWorkerStageObserver,
  type CrabboxProvisionStageEvent,
} from "./crabbox-worker-provision-telemetry.js";

describe("Crabbox provisioning telemetry", () => {
  it.each([true, false])(
    "keeps ambiguous abort ownership unknown, already aborted=%s",
    async (alreadyAborted) => {
      const controller = new AbortController();
      const runtime = alreadyAborted ? controller : new AbortController();
      if (alreadyAborted) {
        controller.abort(new Error("private-reason"));
      } else {
        controller.signal.addEventListener(
          "abort",
          () => runtime.abort(new Error("private-runtime-reason")),
          { once: true },
        );
      }
      const events: CrabboxProvisionStageEvent[] = [];
      const telemetry = createCrabboxProvisionTelemetry("operation-1", "cbx_1", (event) =>
        events.push(event),
      );
      const stage = telemetry.stage("runtime-preparation", async () => 42, {
        caller: controller.signal,
        runtime: runtime.signal,
      });
      if (!alreadyAborted) {
        controller.abort(new Error("private-caller-reason"));
      }
      const result = await stage;
      expect(result).toBe(42);
      expect(events.at(-1)).toMatchObject({
        outcome: "completed",
        firstAbortSource: "unknown",
        abortedSources: ["caller", "runtime"],
        abortReasonCategory: "unknown",
      });
      expect(JSON.stringify(events)).not.toContain("private-");
    },
  );

  it.each(["caller", "project", "runtime"] as const)(
    "retains first %s abort while the actual stage is still unsettled",
    async (source) => {
      const events: CrabboxProvisionStageEvent[] = [];
      const telemetry = createCrabboxProvisionTelemetry("operation-1", "cbx_1", (event) =>
        events.push(event),
      );
      const controllers = {
        caller: new AbortController(),
        project: new AbortController(),
        runtime: new AbortController(),
      };
      const pending = createDeferred();
      const failure = new Error("private-abort-reason");
      const stage = telemetry.stage("runtime-preparation", () => pending.promise, {
        caller: controllers.caller.signal,
        project: controllers.project.signal,
        runtime: controllers.runtime.signal,
      });
      const outcome = stage.catch((error: unknown) => error);
      controllers[source].abort(failure);
      for (const controller of Object.values(controllers)) {
        controller.abort(new DOMException("private-timeout", "TimeoutError"));
      }
      expect(events.filter((event) => event.outcome === "failed")).toHaveLength(0);
      pending.reject(failure);
      expect(await outcome).toBe(failure);
      expect(events.at(-1)).toMatchObject({
        outcome: "failed",
        firstAbortSource: source,
        abortReasonCategory: "unknown",
        abortedSources: ["caller", "project", "runtime"],
      });
      expect(JSON.stringify(events)).not.toContain("private-");
    },
  );

  it("records terminal timing and a safe error class without error content", async () => {
    const events: CrabboxProvisionStageEvent[] = [];
    let time = 100;
    const telemetry = createCrabboxProvisionTelemetry(
      "operation-1",
      "cbx_1",
      (event) => events.push(event),
      () => time,
    );
    await expect(
      telemetry.stage("ssh-ready", async () => {
        time += 17;
        throw new Error("Bearer secret-value");
      }),
    ).rejects.toThrow("Bearer secret-value");
    expect(events).toEqual([
      {
        leaseId: "cbx_1",
        operationId: "operation-1",
        stage: "ssh-ready",
        elapsedMs: 0,
        totalElapsedMs: 0,
        outcome: "started",
      },
      {
        leaseId: "cbx_1",
        operationId: "operation-1",
        stage: "ssh-ready",
        elapsedMs: 17,
        totalElapsedMs: 17,
        outcome: "failed",
        errorCode: "Error",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("forwards only exact lease milestones from streamed command output", () => {
    const events: CrabboxProvisionStageEvent[] = [];
    const observe = createCrabboxWorkerStageObserver("cbx_1", "operation-1", (event) =>
      events.push(event),
    );
    const marker =
      'CRABBOX_WORKER_STAGE:{"leaseId":"cbx_1","stage":"installation","elapsedMs":23,"totalElapsedMs":71,"outcome":"completed"}\n';
    observe(Buffer.from(marker.slice(0, 38)), "stderr");
    observe(Buffer.from(marker.slice(38)), "stderr");
    observe(Buffer.from(marker.replace("cbx_1", "cbx_other")), "stderr");
    observe(Buffer.from(marker.replace("installation", "secret-value")), "stderr");
    observe(Buffer.from("Bearer secret-value\n"), "stderr");
    expect(events).toEqual([
      {
        leaseId: "cbx_1",
        operationId: "operation-1",
        stage: "worker-installation",
        elapsedMs: 23,
        totalElapsedMs: 71,
        outcome: "completed",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("projects bounded cache facts without raw home paths or arbitrary metadata", () => {
    const events: CrabboxProvisionStageEvent[] = [];
    const observe = createCrabboxWorkerStageObserver("cbx_1", "operation-1", (event) =>
      events.push(event),
    );
    const cache = {
      expectedSha256: "a".repeat(64),
      homeCategory: "other",
      uidCategory: "non-root",
      cacheHit: false,
      missReason: "runtime_missing",
      privatePath: "/home/private-user",
    };
    const send = (runtimeCache: unknown, leaseId = "cbx_1") =>
      observe(
        Buffer.from(
          "CRABBOX_WORKER_STAGE:" +
            JSON.stringify({
              leaseId,
              stage: "cache",
              elapsedMs: 3,
              totalElapsedMs: 4,
              outcome: "completed",
              runtimeCache,
            }) +
            "\n",
        ),
        "stderr",
      );
    send(cache);
    send({ ...cache, missReason: "Bearer private-token" });
    send(cache, "other-lease");
    expect(events).toEqual([
      {
        leaseId: "cbx_1",
        operationId: "operation-1",
        stage: "worker-cache",
        elapsedMs: 3,
        totalElapsedMs: 4,
        outcome: "completed",
        runtimeCache: {
          expectedSha256: "a".repeat(64),
          homeCategory: "other",
          uidCategory: "non-root",
          cacheHit: false,
          missReason: "runtime_missing",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-");
  });
});
