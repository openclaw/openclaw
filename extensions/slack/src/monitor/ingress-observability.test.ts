// Slack tests cover ingress observability adapter behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildSlackIngressCorrelation,
  createSlackIngressScopedObserver,
  observeSlackIngressApiCall,
  observeSlackIngressStage,
} from "./ingress-observability.js";

function createIngressObserver() {
  const finish = vi.fn((_outcome?: unknown) => {});
  return {
    stage: vi.fn(),
    progress: vi.fn(),
    correlate: vi.fn(),
    begin: vi.fn(() => ({ finish })),
    finish,
  };
}

describe("Slack ingress observability adapter", () => {
  it("starts API observations before a pending call settles", async () => {
    const observer = createIngressObserver();
    let resolveRun!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });

    const observed = observeSlackIngressApiCall(
      { ingressObserver: observer },
      { method: "conversations.replies", profile: "pooled_listener" },
      () => pending,
    );

    expect(observer.begin).toHaveBeenCalledWith({
      kind: "api",
      method: "conversations.replies",
      profile: "pooled_listener",
    });
    expect(observer.finish).not.toHaveBeenCalled();

    resolveRun("done");
    await expect(observed).resolves.toBe("done");
    expect(observer.finish).toHaveBeenCalledWith("completed");
  });

  it("guards observer callbacks so late observability cannot break ingress", async () => {
    const observer = createIngressObserver();
    observer.stage.mockImplementationOnce(() => {
      throw new Error("late observer failed");
    });
    observer.begin.mockImplementationOnce(() => {
      throw new Error("begin observer failed");
    });

    expect(() =>
      observeSlackIngressStage({ ingressObserver: observer }, { stage: "thread_history" }),
    ).not.toThrow();
    await expect(
      observeSlackIngressApiCall(
        { ingressObserver: observer },
        { method: "users.info" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });

  it("correlates only bounded Slack identifiers", () => {
    const message: Parameters<typeof buildSlackIngressCorrelation>[0]["message"] = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000580",
      text: "do not record this body",
    };
    const correlation = buildSlackIngressCorrelation({
      eventType: "message",
      message,
      teamId: "T111",
    });

    expect(correlation).toEqual({
      providerEventType: "message",
      teamId: "T111",
      channelId: "C111",
      messageTs: "1709000000.000580",
      threadTs: "1709000000.000580",
    });
    expect(JSON.stringify(correlation)).not.toContain("do not record");
    expect(JSON.stringify(correlation)).not.toContain("U111");
  });

  it.each(["conversations.members", "files.download", "usergroups.users.list"] as const)(
    "keeps %s as a fixed observed API method",
    async (method) => {
      const observer = createIngressObserver();

      await observeSlackIngressApiCall({ ingressObserver: observer }, { method }, async () => "ok");

      expect(observer.begin).toHaveBeenCalledWith({
        kind: "api",
        method,
        profile: "pooled_listener",
      });
    },
  );

  it("applies scoped correlation before delegated observation", () => {
    const observer = createIngressObserver();
    const scoped = createSlackIngressScopedObserver(observer, {
      providerEventType: "app_mention",
      teamId: "T111",
      channelId: "C111",
      messageTs: "1709000000.000590",
      threadTs: "1709000000.000590",
    });

    scoped?.progress("routing", "none");

    expect(observer.correlate).toHaveBeenCalledWith({
      providerEventType: "app_mention",
      teamId: "T111",
      channelId: "C111",
      messageTs: "1709000000.000590",
      threadTs: "1709000000.000590",
    });
    expect(observer.progress).toHaveBeenCalledWith("routing", "none");
  });
});
