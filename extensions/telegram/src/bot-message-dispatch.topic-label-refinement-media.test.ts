import { AsyncWorkScope } from "openclaw/plugin-sdk/concurrency-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  generateTopicLabel,
  loadSessionStore,
  readTitleLifecycleForTest,
} from "./bot-message-dispatch.test-harness.js";

const naming = vi.hoisted(() => ({
  prepare: vi.fn(async (): Promise<"initial" | "refine" | "skip"> => "initial"),
  attach: vi.fn(
    async (
      params: Parameters<typeof import("./topic-label-refinement.js").finishInitialTopicLabel>[0],
    ) => {
      await params.applyInitialLabel();
    },
  ),
  refine: vi.fn(async () => {}),
}));
// mock-isolation: this suite owns dispatch-to-naming selection; durable claims
// and rename guards are covered by the refinement owner's tests.
vi.mock("./topic-label-refinement.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topic-label-refinement.js")>()),
  prepareTopicLabelTurn: naming.prepare,
  finishInitialTopicLabel: naming.attach,
  maybeRefineTopicLabel: naming.refine,
}));
// mock-isolation: do not open a topic-cache database for dispatcher selection.
vi.mock("./topic-name-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topic-name-cache.js")>()),
  getTopicName: vi.fn(async () => undefined),
  updateTopicName: vi.fn(async () => {}),
}));

describeTelegramDispatch("DM topic naming for captionless media", () => {
  beforeEach(() => {
    readTitleLifecycleForTest
      .mockReset()
      .mockResolvedValue({ sessionId: "s1", lifecycleRevision: "title-generation-1" });
    naming.prepare.mockReset().mockResolvedValue("initial");
    naming.attach.mockClear();
    naming.refine.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Task reply" }, { kind: "final" });
      return { queuedFinal: true };
    });
  });

  it("preserves custom prompt output beyond the default word-count suggestion", async () => {
    generateTopicLabel.mockResolvedValueOnce("YouGile CRM integration planning guide");
    const scope = new AsyncWorkScope();
    const context = createContext();
    context.ctxPayload.RawBody = "Plan a YouGile CRM integration";
    const bot = createBot();
    const edit = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = edit;
    await scope.track(() =>
      dispatchWithContext({
        context,
        bot,
        telegramCfg: { autoTopicLabel: { prompt: "Return ten words" } },
      }),
    );
    await scope.drain();
    expect(edit).toHaveBeenCalledWith(123, 777, { name: "YouGile CRM integration planning guide" });
    expect(naming.attach).toHaveBeenCalledWith(
      expect.objectContaining({ label: "YouGile CRM integration planning guide" }),
    );
  });

  it("does not start later refinement over an explicit WebUI label", async () => {
    readTitleLifecycleForTest.mockResolvedValue({
      sessionId: "s1",
      lifecycleRevision: "title-generation-1",
      explicitLabel: "My chosen title",
    });
    naming.prepare.mockResolvedValue("refine");
    const scope = new AsyncWorkScope();
    const context = createContext();
    context.ctxPayload.RawBody = "Continue the CRM integration";
    await scope.track(() =>
      dispatchWithContext({
        context,
        telegramCfg: { autoTopicLabel: { refine: true } },
      }),
    );
    await scope.drain();
    expect(naming.refine).not.toHaveBeenCalled();
    expect(generateTopicLabel).not.toHaveBeenCalled();
  });

  it("does not overwrite a WebUI label chosen during initial inference", async () => {
    const scope = new AsyncWorkScope();
    const context = createContext();
    context.ctxPayload.RawBody = "Continue the CRM integration";
    const release = Promise.withResolvers<string>();
    generateTopicLabel.mockImplementationOnce(() => release.promise);
    const bot = createBot();
    const edit = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = edit;
    try {
      await scope.track(() => dispatchWithContext({ context, bot }));
      await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
      readTitleLifecycleForTest.mockResolvedValue({
        sessionId: "s1",
        lifecycleRevision: "title-generation-1",
        explicitLabel: "My chosen title",
      });
      release.resolve("Automatic title");
      await scope.drain();
      expect(edit).not.toHaveBeenCalled();
    } finally {
      release.resolve("Automatic title");
      await scope.drain();
    }
  });

  it("ignores control-only turns and names the subsequent substantive task", async () => {
    const context = createContext();
    const bot = createBot();
    const edit = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = edit;
    for (const text of ["/reset", "/model example"]) {
      const scope = new AsyncWorkScope();
      context.ctxPayload.RawBody = text;
      await scope.track(() => dispatchWithContext({ context, bot }));
      await scope.drain();
    }
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    const scope = new AsyncWorkScope();
    context.ctxPayload.RawBody = "Continue the YouGile CRM integration";
    await scope.track(() => dispatchWithContext({ context, bot }));
    await scope.drain();
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it.each(["image", "document", "audio"] as const)(
    "counts a captionless %s follow-up using current media facts",
    async (kind) => {
      naming.prepare.mockResolvedValueOnce("refine");
      const context = createContext();
      context.ctxPayload.RawBody = "";
      context.ctxPayload.Body = "Envelope containing old quoted text";
      context.ctxPayload.media = [{ kind, path: "/private/current-file" }];
      loadSessionStore.mockReturnValue({ [context.ctxPayload.SessionKey!]: { systemSent: true } });
      await dispatchWithContext({
        context,
        telegramCfg: { autoTopicLabel: { refine: true, refineAfterMessages: 1 } },
      });
      await vi.waitFor(() => {
        expect(naming.refine).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ userMessage: `<media:${kind}>`, afterMessages: 1 }),
        );
      });
    },
  );

  it("names the first captionless media turn before attaching refinement provenance", async () => {
    const context = createContext();
    context.ctxPayload.RawBody = "";
    context.ctxPayload.media = [{ kind: "image" }];
    const bot = createBot();
    const editForumTopic = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = editForumTopic;
    await dispatchWithContext({
      context,
      bot,
      telegramCfg: { autoTopicLabel: { refine: true, refineAfterMessages: 1 } },
    });
    await vi.waitFor(() => expect(naming.attach).toHaveBeenCalledTimes(1));
    expect(editForumTopic).toHaveBeenCalledWith(123, 777, { name: "Topic label" });
    expect(naming.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ lifecycleRevision: "title-generation-1" }),
    );
  });

  it("retains first-turn naming while the foreground settles before refinement arming finishes", async () => {
    const scope = new AsyncWorkScope();
    const release = Promise.withResolvers<void>();
    naming.prepare.mockImplementationOnce(async () => {
      await release.promise;
      return "initial";
    });
    // The model boundary admits work only while its foreground owner is live.
    generateTopicLabel.mockImplementation(() => scope.track(async () => "Owned topic label"));
    const bot = createBot();
    const edit = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = edit;
    const context = createContext();
    context.ctxPayload.RawBody = "";
    context.ctxPayload.media = [{ kind: "image" }];
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };
    let foregroundSettled = false;
    const dispatched = scope.track(() =>
      dispatchWithContext({
        context,
        bot,
        runtime,
        telegramCfg: { autoTopicLabel: { refine: true, refineAfterMessages: 2 } },
      }).then(() => {
        foregroundSettled = true;
      }),
    );
    try {
      await vi.waitFor(() => expect(naming.prepare).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await vi.waitFor(
        () =>
          expect({ foregroundSettled, errors: runtime.error.mock.calls }).toEqual({
            foregroundSettled: true,
            errors: [],
          }),
        { timeout: 5000 },
      );
      expect(runtime.error.mock.calls).toEqual([]);
      await vi.waitFor(() => expect(naming.prepare).toHaveBeenCalledTimes(1));
      const settled = AsyncWorkScope.runWhenAllIdle(
        () => [scope],
        () => scope.drain(),
      );
      release.resolve();
      await settled;
      await vi.waitFor(() =>
        expect(edit).toHaveBeenCalledWith(123, 777, { name: "Owned topic label" }),
      );
      expect(naming.attach).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await dispatched;
      await AsyncWorkScope.runWhenAllIdle(
        () => [scope],
        () => scope.drain(),
      );
    }
  });

  it("retains a later refinement after foreground dispatch settles", async () => {
    naming.prepare.mockResolvedValueOnce("refine");
    const scope = new AsyncWorkScope();
    const release = Promise.withResolvers<void>();
    naming.refine.mockImplementationOnce(async () => {
      await release.promise;
    });
    const context = createContext();
    context.ctxPayload.RawBody = "";
    context.ctxPayload.media = [{ kind: "image" }];
    loadSessionStore.mockReturnValue({ [context.ctxPayload.SessionKey!]: { systemSent: true } });
    try {
      await scope.track(() =>
        dispatchWithContext({
          context,
          telegramCfg: { autoTopicLabel: { refine: true, refineAfterMessages: 2 } },
        }),
      );
      await vi.waitFor(() => expect(naming.refine).toHaveBeenCalledTimes(1));
      let drained = false;
      const settled = AsyncWorkScope.runWhenAllIdle(
        () => [scope],
        () => scope.drain(),
      ).then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.resolve();
      await settled;
      expect(drained).toBe(true);
    } finally {
      release.resolve();
      await AsyncWorkScope.runWhenAllIdle(
        () => [scope],
        () => scope.drain(),
      );
    }
  });

  it.each(["before generation", "during generation"] as const)(
    "does not rename when the account stops %s",
    async (timing) => {
      const scope = new AsyncWorkScope();
      const stopped = new AbortController();
      const release = Promise.withResolvers<string>();
      generateTopicLabel.mockImplementation(() => release.promise);
      if (timing === "before generation") {
        stopped.abort();
      }
      const context = createContext();
      context.ctxPayload.RawBody = "";
      context.ctxPayload.media = [{ kind: "image" }];
      const bot = createBot();
      const edit = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
      bot.api.editForumTopic = edit;
      try {
        await scope.track(() =>
          dispatchWithContext({
            context,
            bot,
            opts: { token: "token", accountAbortSignal: stopped.signal },
            telegramCfg: { autoTopicLabel: { refine: true, refineAfterMessages: 2 } },
          }),
        );
        if (timing === "during generation") {
          await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
          stopped.abort();
        } else {
          expect(generateTopicLabel).not.toHaveBeenCalled();
        }
        release.resolve("Late model label");
        await AsyncWorkScope.runWhenAllIdle(
          () => [scope],
          () => scope.drain(),
        );
        expect(edit).not.toHaveBeenCalled();
      } finally {
        release.resolve("Late model label");
        await AsyncWorkScope.runWhenAllIdle(
          () => [scope],
          () => scope.drain(),
        );
      }
    },
  );
});
