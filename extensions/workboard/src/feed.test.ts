import { describe, expect, it, vi } from "vitest";
import { mergeFeedPatch } from "./feed-normalize.js";
import { resolveFeedNotifySession, selectFeedCards } from "./feed.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function setup() {
  const store = createWorkboardSqliteTestStore();
  const gateway = { request: vi.fn(async () => ({ runId: "run-1" })) };
  const { api, invoke } = createGatewayMethodCapture();
  Object.assign(api, { pluginConfig: { feed: { boards: ["owner"], ownerName: "Sam" } } });
  Object.assign(api.runtime, { gateway });
  registerWorkboardGatewayMethods({ api, store });
  const call = async (method: string, params: Record<string, unknown>) => {
    const [ok, payload, error] = (await invoke(method, params)).mock.calls[0] ?? [];
    if (!ok) {
      throw new Error(error?.message ?? "request failed");
    }
    return payload as Record<string, unknown>;
  };
  return { store, gateway, call };
}

function toolsFor(store: ReturnType<typeof createWorkboardSqliteTestStore>, agentId: string) {
  const tools = createWorkboardTools({
    store,
    context: { agentId, sessionKey: `agent:${agentId}:main` },
    feedConfig: { boards: ["owner"] },
  });
  return (name: string) => tools.find((tool) => tool.name === name)!;
}

const emailFeed = {
  tag: "EMAIL · DRAFT",
  summary: "She asked yesterday; you said Friday.",
  draftHeader: "To: Dana\nRe: Q3 proposal",
  draft: "Hi Dana,\n\nHere is the proposal.",
  actions: [
    { label: "Send", message: "Send the Q3 proposal email now.", style: "primary" },
    { label: "Edit draft", message: "Rework the draft." },
  ],
};

describe("workboard feed", () => {
  it("validates feed fields and merges patches, with empty values clearing a field", () => {
    const feed = mergeFeedPatch(undefined, emailFeed);
    expect(feed?.actions?.map((action) => action.id)).toEqual(["send", "edit-draft"]);
    const next = mergeFeedPatch(
      { ...feed, ackedAt: 5, ackedAction: "send" },
      {
        summary: "",
        links: [{ label: "Open draft", url: "https://mail.example.com/d/1" }],
        reopen: true,
      },
    );
    expect(next?.summary).toBeUndefined();
    expect(next?.ackedAt).toBeUndefined();
    expect(next?.draft).toBe(emailFeed.draft);
    expect(() => mergeFeedPatch(undefined, { draft: "x".repeat(6001) })).toThrow(/6000/);
    expect(() =>
      mergeFeedPatch(undefined, { links: [{ label: "x", url: "file:///etc" }] }),
    ).toThrow(/http/);
  });

  it("stores feed metadata and the creator's notify session from workboard_create", async () => {
    const { store } = setup();
    const tool = toolsFor(store, "content");
    const result = await tool("workboard_create").execute("call-1", {
      title: "LinkedIn: approve the launch post",
      boardId: "owner",
      feed: { tag: "LINKEDIN · DRAFT", draft: "We shipped it." },
    });
    const card = (result.details as { card: { id: string } }).card;
    const stored = await store.get(card.id);
    expect(stored?.metadata?.feed).toEqual({
      tag: "LINKEDIN · DRAFT",
      draft: "We shipped it.",
      notify: "agent:content:main",
    });
    // A plain card on a Feed board still remembers who to tell.
    const plain = await tool("workboard_create").execute("call-2", {
      title: "Decide the pricing tier",
      boardId: "owner",
    });
    const plainId = (plain.details as { card: { id: string } }).card.id;
    expect(resolveFeedNotifySession((await store.get(plainId))!)).toBe("agent:content:main");
    // Cards elsewhere without feed fields stay out of the Feed and carry no feed record.
    const other = await store.create({ title: "Unrelated", boardId: "ops" });
    expect(other.metadata?.feed).toBeUndefined();
    const selected = selectFeedCards(await store.list(), { boards: ["owner"] });
    expect(selected.map((entry) => entry.title).toSorted()).toEqual([
      "Decide the pricing tier",
      "LinkedIn: approve the launch post",
    ]);
  });

  it("routes an action click with the edited draft and acks without finishing the card", async () => {
    const { store, gateway, call } = setup();
    const card = await store.create({
      title: "Dana is waiting on the Q3 proposal",
      boardId: "owner",
      metadata: { feed: { ...emailFeed, notify: "agent:email:main" } },
    });
    const result = await call("workboard.feed.act", {
      id: card.id,
      actionId: "send",
      draft: "Hi Dana,\n\nHere is the proposal. Pricing is on slide 6.",
      idempotencyKey: "click-1",
    });
    expect(gateway.request).toHaveBeenCalledTimes(1);
    const [method, params, options] = gateway.request.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      unknown,
    ];
    expect(method).toBe("sessions.send");
    expect(options).toEqual({ scopes: ["operator.write"] });
    expect(params.key).toBe("agent:email:main");
    expect(params.idempotencyKey).toBe("click-1");
    expect(params.message).toContain(
      `[Feed] Sam clicked "Send" on card ${card.id} "Dana is waiting on the Q3 proposal".`,
    );
    expect(params.message).toContain("Send the Q3 proposal email now.");
    expect(params.message).toContain("> Here is the proposal. Pricing is on slide 6.");
    expect(params.message).toContain(`workboard_comment with id "${card.id}"`);
    expect(result.routed).toEqual({ sessionKey: "agent:email:main", runId: "run-1" });
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("todo");
    expect(stored?.metadata?.feed).toMatchObject({
      ackedAction: "send",
      draft: "Hi Dana,\n\nHere is the proposal. Pricing is on slide 6.",
    });
    expect(stored?.metadata?.feed?.ackedAt).toEqual(expect.any(Number));
  });

  it("keeps the card open when routing fails", async () => {
    const { store, gateway, call } = setup();
    gateway.request.mockRejectedValueOnce(new Error("session not found"));
    const card = await store.create({ title: "Decide", metadata: { feed: emailFeed } });
    await expect(call("workboard.feed.act", { id: card.id, actionId: "send" })).rejects.toThrow(
      "session not found",
    );
    expect((await store.get(card.id))?.metadata?.feed?.ackedAt).toBeUndefined();
    // No notify and no assignee falls back to the main agent session.
    expect(resolveFeedNotifySession(card)).toBe("agent:main:main");
  });

  it("stores an owner comment, acks, routes it, and an agent reply reopens the card", async () => {
    const { store, gateway, call } = setup();
    const card = await store.create({
      title: "Pick the conference",
      agentId: "events",
      boardId: "owner",
    });
    await call("workboard.feed.comment", { id: card.id, body: "Only if the booth is under 5k." });
    const [, params] = gateway.request.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(params.key).toBe("agent:events:main");
    expect(params.message).toContain(
      `[Feed] Sam commented on card ${card.id} "Pick the conference": Only if the booth is under 5k.`,
    );
    expect(params.message).not.toContain("edited the draft");
    const acked = await store.get(card.id);
    const ackedAt = acked?.metadata?.feed?.ackedAt;
    expect(ackedAt).toEqual(expect.any(Number));
    expect(acked?.metadata?.comments?.[0]).toMatchObject({
      body: "Only if the booth is under 5k.",
      author: { kind: "owner" },
    });

    const tool = toolsFor(store, "events");
    await tool("workboard_comment").execute("call-3", {
      id: card.id,
      body: "Booth is 4.2k. Book it?",
    });
    const replied = await store.get(card.id);
    const reply = replied?.metadata?.comments?.at(-1);
    expect(reply).toMatchObject({ author: { kind: "agent", id: "events" } });
    // Reopening is derived: an agent comment newer than the ack puts it back in front.
    expect(reply!.createdAt).toBeGreaterThanOrEqual(ackedAt!);
  });

  it("reopens the card when the agent replies before the owner's ack is written", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const { store, gateway, call } = setup();
      const card = await store.create({
        title: "Pick the conference",
        agentId: "events",
        boardId: "owner",
        metadata: { feed: emailFeed },
      });
      const tool = toolsFor(store, "events");
      const replyDuringSend = (body: string) => async () => {
        vi.setSystemTime(Date.now() + 1_000);
        await tool("workboard_comment").execute("call-race", { id: card.id, body });
        vi.setSystemTime(Date.now() + 1_000);
        return { runId: "run-1" };
      };
      for (const request of [
        () => call("workboard.feed.act", { id: card.id, actionId: "send" }),
        () => call("workboard.feed.comment", { id: card.id, body: "Only under 5k." }),
      ]) {
        gateway.request.mockImplementationOnce(replyDuringSend("Booked."));
        await request();
        const stored = await store.get(card.id);
        const reply = stored?.metadata?.comments?.at(-1);
        expect(reply).toMatchObject({ body: "Booked.", author: { kind: "agent" } });
        expect(reply!.createdAt).toBeGreaterThan(stored!.metadata!.feed!.ackedAt!);
      }
      // The owner comment keeps its pre-send time and sorts before the reply it caused.
      const comments = (await store.get(card.id))?.metadata?.comments ?? [];
      expect(comments.map((comment) => comment.body)).toEqual([
        "Booked.",
        "Only under 5k.",
        "Booked.",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an emptied draft instead of dropping the owner's edit", async () => {
    const { store, gateway, call } = setup();
    const card = await store.create({ title: "Decide", metadata: { feed: emailFeed } });
    await expect(
      call("workboard.feed.act", { id: card.id, actionId: "send", draft: "  " }),
    ).rejects.toThrow("The draft is empty");
    await expect(call("workboard.feed.update", { id: card.id, draft: "" })).rejects.toThrow(
      "The draft is empty",
    );
    await expect(
      call("workboard.feed.comment", { id: card.id, body: "ok", draft: "\n" }),
    ).rejects.toThrow("The draft is empty");
    expect(gateway.request).not.toHaveBeenCalled();
    const stored = await store.get(card.id);
    expect(stored?.metadata?.feed).toMatchObject({ draft: emailFeed.draft });
    expect(stored?.metadata?.feed?.ackedAt).toBeUndefined();
  });

  it("acks and undoes, and agents can reopen through workboard_feed", async () => {
    const { store, call } = setup();
    const card = await store.create({ title: "FYI: invoice paid", metadata: { feed: emailFeed } });
    await call("workboard.feed.ack", { id: card.id });
    expect((await store.get(card.id))?.metadata?.feed?.ackedAt).toEqual(expect.any(Number));
    await call("workboard.feed.ack", { id: card.id, acked: false });
    expect((await store.get(card.id))?.metadata?.feed?.ackedAt).toBeUndefined();

    await call("workboard.feed.ack", { id: card.id });
    const tool = toolsFor(store, "email");
    await tool("workboard_feed").execute("call-4", {
      id: card.id,
      summary: "New draft after your note.",
      reopen: true,
    });
    const reopened = await store.get(card.id);
    expect(reopened?.metadata?.feed).toMatchObject({
      summary: "New draft after your note.",
      notify: "agent:email:main",
    });
    expect(reopened?.metadata?.feed?.ackedAt).toBeUndefined();

    await call("workboard.feed.update", { id: card.id, draft: "Shorter draft." });
    expect((await store.get(card.id))?.metadata?.feed?.draft).toBe("Shorter draft.");
    const listed = await call("workboard.feed.list", {});
    expect(listed).toMatchObject({ boards: ["owner"], ownerName: "Sam" });
    expect((listed.cards as unknown[]).length).toBe(1);
  });

  it("sends a saved draft edit with the next click or comment until the agent replaces it", async () => {
    const { store, gateway, call } = setup();
    const card = await store.create({
      title: "Dana is waiting on the Q3 proposal",
      metadata: { feed: { ...emailFeed, notify: "agent:email:main" } },
    });
    await call("workboard.feed.update", { id: card.id, draft: "Hi Dana, short version." });
    await call("workboard.feed.comment", { id: card.id, body: "Also cc Lee." });
    await call("workboard.feed.act", { id: card.id, actionId: "send" });
    const messages = gateway.request.mock.calls.map(
      (entry) => (entry as unknown as [string, Record<string, string>])[1].message,
    );
    for (const message of messages) {
      expect(message).toContain(
        "They edited the draft first. Use this text:\n> Hi Dana, short version.",
      );
    }
    // A new agent draft replaces the owner's edit, so the next click sends no override.
    const tool = toolsFor(store, "email");
    await tool("workboard_feed").execute("call-5", {
      id: card.id,
      draft: "Hi Dana, v2.",
      reopen: true,
    });
    expect((await store.get(card.id))?.metadata?.feed?.draftEdited).toBeUndefined();
    await call("workboard.feed.act", { id: card.id, actionId: "send" });
    expect(
      (gateway.request.mock.calls.at(-1) as unknown as [string, Record<string, string>])[1].message,
    ).not.toContain("edited the draft");
  });

  it("snoozes silently, and an agent reply, reopen or owner ack wakes the card", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const { store, gateway, call } = setup();
      const card = await store.create({ title: "Decide", agentId: "email", boardId: "owner" });
      const snooze = (until: unknown) => call("workboard.feed.snooze", { id: card.id, until });
      const snoozedUntil = async () => (await store.get(card.id))?.metadata?.feed?.snoozedUntil;
      await expect(snooze(Date.now())).rejects.toThrow("in the future");
      await expect(snooze(Date.now() + 400 * 24 * 60 * 60 * 1000)).rejects.toThrow(
        "at most a year",
      );
      await expect(snooze("soon")).rejects.toThrow("epoch milliseconds");

      const until = Date.now() + 60 * 60 * 1000;
      await snooze(until);
      expect(await snoozedUntil()).toBe(until);
      expect((await store.get(card.id))?.metadata?.feed?.ackedAt).toBeUndefined();
      expect(gateway.request).not.toHaveBeenCalled();
      await snooze(null);
      expect(await snoozedUntil()).toBeUndefined();

      const tool = toolsFor(store, "email");
      await snooze(until);
      await tool("workboard_comment").execute("call-6", { id: card.id, body: "Dana replied." });
      expect(await snoozedUntil()).toBeUndefined();
      await snooze(until);
      await tool("workboard_feed").execute("call-7", { id: card.id, snoozedUntil: 1 } as never);
      expect(await snoozedUntil()).toBe(until);
      await tool("workboard_feed").execute("call-8", { id: card.id, reopen: true });
      expect(await snoozedUntil()).toBeUndefined();
      await snooze(until);
      await call("workboard.feed.ack", { id: card.id });
      expect(await snoozedUntil()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an agent snooze a card on create, update and comment", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-10-14T10:00:00Z"));
      const { store } = setup();
      const tool = toolsFor(store, "revenue");
      const snoozedUntil = async (id: string) =>
        (await store.get(id))?.metadata?.feed?.snoozedUntil;
      const friday = Date.parse("2026-10-16T09:00:00+02:00");

      const created = await tool("workboard_create").execute("call-1", {
        title: "Give Ferenc until Friday",
        boardId: "owner",
        feed: { summary: "Ping him then.", snoozeUntil: "2026-10-16T09:00:00+02:00" },
      });
      const id = (created.details as { card: { id: string } }).card.id;
      expect(await snoozedUntil(id)).toBe(friday);

      // A plain agent comment still wakes the card early.
      await tool("workboard_comment").execute("call-2", { id, body: "He answered." });
      expect(await snoozedUntil(id)).toBeUndefined();

      // A comment that passes snoozeUntil snoozes it instead, epoch ms works too.
      await tool("workboard_comment").execute("call-3", {
        id,
        body: "Pinging him Friday.",
        snoozeUntil: friday,
      });
      expect(await snoozedUntil(id)).toBe(friday);

      // reopen clears the ack, and snoozeUntil in the same call keeps it hidden until then.
      await store.ackFeed(id, { acked: true });
      const later = friday + 60 * 60 * 1000;
      await tool("workboard_feed").execute("call-4", {
        id,
        summary: "Still waiting.",
        reopen: true,
        snoozeUntil: String(later),
      });
      const feed = (await store.get(id))?.metadata?.feed;
      expect(feed?.ackedAt).toBeUndefined();
      expect(feed?.snoozedUntil).toBe(later);

      // Leaving snoozeUntil out keeps it; "" or null clears it.
      await tool("workboard_feed").execute("call-5", { id, summary: "Edited." });
      expect(await snoozedUntil(id)).toBe(later);
      await tool("workboard_feed").execute("call-6", { id, snoozeUntil: "" });
      expect(await snoozedUntil(id)).toBeUndefined();
      await tool("workboard_feed").execute("call-7", { id, snoozeUntil: friday });
      await tool("workboard_feed").execute("call-8", { id, snoozeUntil: null });
      expect(await snoozedUntil(id)).toBeUndefined();

      for (const bad of ["next friday", Date.now() - 1, Date.now() + 400 * 24 * 60 * 60 * 1000]) {
        await expect(
          tool("workboard_feed").execute("call-9", { id, snoozeUntil: bad }),
        ).rejects.toThrow("snoozeUntil");
      }
      await expect(
        tool("workboard_comment").execute("call-10", { id, body: "x", snoozeUntil: "soon" }),
      ).rejects.toThrow("snoozeUntil");
      expect(await snoozedUntil(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
