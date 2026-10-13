/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiHost, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { WorkboardToast } from "../../components/toast.tsx";
import { workboardLocale } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import type { FeedStore } from "../../lib/feed/feed-store.ts";
import { feedGreeting, type FeedItem } from "../../lib/feed/feed-view.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardComment, WorkboardFeedAction } from "../../lib/workboard/types.ts";
import { liveInputValue } from "../workboard/view-input-value.ts";
import { FeedMarkdown } from "./feed-markdown.tsx";

/** How long a decided card shows its checked state before it folds into the handled list. */
const FEED_CONFIRM_MS = 900;
const FEED_COLLAPSE_MS = 320;
const FEED_THREAD_PREVIEW = 2;
const FEED_HANDLED_PREVIEW = 5;
const FEED_BODY_FOLD_CHARS = 280;
const ACK = "__ack";
const COMMENT = "__comment";

type Phase = "idle" | "pending" | "confirmed" | "collapsing";
type Held = ReadonlyMap<string, { item: FeedItem; index: number }>;

function formatTime(at: number, now: number): string {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) {
    return date.toLocaleTimeString(workboardLocale(), { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return date.toDateString() === yesterday.toDateString()
    ? t("feed.yesterday")
    : date.toLocaleDateString(workboardLocale(), { month: "short", day: "numeric" });
}

function agentName(host: ControlUiHost, agentId: string | undefined): string {
  const agent = agentId ? host.agents.rows.find((row) => row.id === agentId) : undefined;
  return agent?.name ?? agent?.identity?.name ?? agentId ?? t("feed.agentFallback");
}

function notifyAgentId(item: FeedItem): string {
  return /^agent:([^:]+):/.exec(item.feed.notify ?? "")?.[1] ?? item.card.agentId ?? "main";
}

function autosize(area: HTMLTextAreaElement) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

function focusLater(element: HTMLTextAreaElement) {
  requestAnimationFrame(() => {
    autosize(element);
    element.focus();
  });
}

type CardProps = {
  item: FeedItem;
  index: number;
  now: number;
  host: ControlUiHost;
  feed: FeedStore;
  hold: (item: FeedItem, index: number) => void;
  release: (id: string) => void;
  notice: (message: string, undo?: () => void) => void;
};

function FeedCard(props: CardProps) {
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [pendingAction, setPendingAction] = createSignal<string>();
  const [confirmedLabel, setConfirmedLabel] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [draftText, setDraftText] = createSignal("");
  const [commentOpen, setCommentOpen] = createSignal(false);
  const [commentText, setCommentText] = createSignal("");
  const [bodyExpanded, setBodyExpanded] = createSignal(false);
  const [threadExpanded, setThreadExpanded] = createSignal(false);
  const [error, setError] = createSignal("");
  const draftValue = liveInputValue(draftText);
  const commentValue = liveInputValue(commentText);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let element: HTMLElement | undefined;
  onCleanup(() => timers.forEach(clearTimeout));
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  const locked = () => phase() !== "idle";
  const decided = () => phase() === "confirmed" || phase() === "collapsing";
  const agent = () => agentName(props.host, notifyAgentId(props.item));

  // Keep the decided card in place, checked, then fold it into the handled list.
  const collapse = (label: string) => {
    setConfirmedLabel(label);
    setPhase("confirmed");
    later(FEED_CONFIRM_MS, () => {
      setPhase("collapsing");
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (element && !reduceMotion) {
        element.animate(
          [
            { height: `${element.getBoundingClientRect().height}px`, opacity: 1 },
            { height: "0px", opacity: 0, marginBottom: "-12px" },
          ],
          { duration: FEED_COLLAPSE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
        );
      }
      later(reduceMotion ? 0 : FEED_COLLAPSE_MS, () => props.release(props.item.card.id));
    });
  };

  const run = async (id: string, request: () => Promise<void>, done: () => void) => {
    if (locked()) {
      return;
    }
    setPhase("pending");
    setPendingAction(id);
    setError("");
    // Hold first: the store publishes the acked card before the request resolves, and an
    // unheld card would remount with idle buttons that could send the decision again.
    props.hold(props.item, props.index);
    try {
      await request();
      done();
    } catch (failure) {
      props.release(props.item.card.id);
      setPhase("idle");
      setPendingAction(undefined);
      setError(formatUiError(failure));
    }
  };

  const act = (action: WorkboardFeedAction) =>
    void run(
      action.id,
      () => props.feed.act(props.item.card.id, action.id, editing() ? draftText() : undefined),
      () => {
        setEditing(false);
        collapse(action.doneLabel ?? action.label);
        props.notice(t("feed.sentTo", { agent: agent() }));
      },
    );
  const ack = () =>
    void run(
      ACK,
      () => props.feed.ack(props.item.card.id, true),
      () => {
        collapse(t("feed.done"));
        props.notice(
          t("feed.movedToHandled"),
          () => void props.feed.ack(props.item.card.id, false),
        );
      },
    );
  const comment = () => {
    const body = commentText().trim();
    if (body) {
      void run(
        COMMENT,
        () => props.feed.comment(props.item.card.id, body, editing() ? draftText() : undefined),
        () => {
          setEditing(false);
          setCommentText("");
          setCommentOpen(false);
          collapse(t("feed.replied"));
          props.notice(t("feed.sentTo", { agent: agent() }));
        },
      );
    }
  };
  const saveDraft = async () => {
    setError("");
    try {
      await props.feed.saveDraft(props.item.card.id, draftText());
      setEditing(false);
    } catch (failure) {
      setError(formatUiError(failure));
    }
  };

  const bodyLong = () => {
    const body = props.item.body ?? "";
    return body.length > FEED_BODY_FOLD_CHARS || body.split("\n").length > 5;
  };
  const hiddenComments = () =>
    threadExpanded() ? 0 : Math.max(0, props.item.comments.length - FEED_THREAD_PREVIEW);
  const commentAuthor = (entry: WorkboardComment) =>
    entry.author?.kind === "owner"
      ? t("feed.you")
      : entry.author?.kind === "agent"
        ? agentName(props.host, entry.author.id)
        : t("feed.note");
  const metricMax = () =>
    Math.max(1, ...(props.item.feed.metric?.bars ?? []).map((bar) => Math.abs(bar.value)));

  return (
    <article
      ref={(node) => {
        element = node;
      }}
      class={[
        "wb-feed-card",
        `wb-feed-card--${props.item.card.priority}`,
        { "wb-feed-card--unread": props.item.unread, "wb-feed-card--decided": decided() },
      ]}
      aria-label={props.item.title}
    >
      <header class="wb-feed-card__top">
        <span class={["wb-feed-card__source", { "wb-feed-card__source--done": decided() }]}>
          {decided() ? icons.check : icons[props.item.icon]}
        </span>
        <span class="wb-feed-card__tag">{props.item.tag || t("feed.needsYou")}</span>
        <Show when={props.item.unread}>
          <span class="wb-feed-card__unread">{t("feed.newReply")}</span>
        </Show>
        <Show when={props.item.card.priority === "urgent"}>
          <span class="wb-feed-card__urgent">{t("feed.urgent")}</span>
        </Show>
        <time class="wb-feed-card__time" datetime={new Date(props.item.sortAt).toISOString()}>
          {formatTime(props.item.sortAt, props.now)}
        </time>
      </header>
      <h2 class="wb-feed-card__title">{props.item.title}</h2>
      <Show when={props.item.summary}>
        <p class="wb-feed-card__summary">
          <span class="wb-feed-card__summary-icon" aria-hidden="true">
            {icons.lightbulb}
          </span>
          <span>{props.item.summary}</span>
        </p>
      </Show>
      <Show when={props.item.feed.metric}>
        {(metric) => (
          <div class="wb-feed-metric">
            <div>
              <div class="wb-feed-metric__value">{metric().value}</div>
              <Show when={metric().delta}>
                <div class="wb-feed-metric__delta">{metric().delta}</div>
              </Show>
              <Show when={metric().caption}>
                <div class="wb-feed-metric__caption">{metric().caption}</div>
              </Show>
            </div>
            <Show when={metric().bars?.length}>
              <div class="wb-feed-metric__bars" aria-hidden="true">
                <For each={metric().bars} keyed={false}>
                  {(bar, index) => (
                    <div class="wb-feed-metric__bar-col">
                      <div
                        class={[
                          "wb-feed-metric__bar",
                          {
                            "wb-feed-metric__bar--current":
                              index === (metric().bars?.length ?? 0) - 1,
                          },
                        ]}
                        style={{
                          height: `${Math.max(6, (Math.abs(bar().value) / metricMax()) * 100)}%`,
                        }}
                      />
                      <span>{bar().label}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.item.feed.draft !== undefined || editing()}>
        <div class={["wb-feed-draft", { "wb-feed-draft--editing": editing() }]}>
          <Show when={props.item.feed.draftHeader}>
            {(header) => (
              <div class="wb-feed-draft__header">
                <For each={header().split("\n")} keyed={false}>
                  {(line) => {
                    const split = () => /^([^:]{1,16}):\s*(.*)$/.exec(line());
                    return (
                      <div>
                        <Show
                          when={split()}
                          fallback={<span class="wb-feed-draft__value">{line()}</span>}
                        >
                          {(parts) => (
                            <>
                              <span class="wb-feed-draft__key">{parts()[1]}</span>
                              <span class="wb-feed-draft__value">{parts()[2]}</span>
                            </>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </Show>
          <Show
            when={editing()}
            fallback={
              <>
                <div class="wb-feed-draft__body">{props.item.feed.draft}</div>
                <Show when={!locked()}>
                  <button
                    type="button"
                    class="wb-feed-draft__edit"
                    aria-label={t("feed.editDraft")}
                    title={t("feed.editDraft")}
                    onClick={() => {
                      setDraftText(props.item.feed.draft ?? "");
                      setEditing(true);
                    }}
                  >
                    {icons.penLine}
                    <span>{t("feed.edit")}</span>
                  </button>
                </Show>
              </>
            }
          >
            <textarea
              class="wb-feed-draft__input"
              aria-label={t("feed.editDraft")}
              ref={(node) => {
                draftValue(node);
                node.value = draftText();
                focusLater(node);
              }}
              onInput={(event) => {
                setDraftText(event.currentTarget.value);
                autosize(event.currentTarget);
              }}
            />
            <div class="wb-feed-draft__edit-actions">
              <button type="button" class="btn btn--ghost" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                class="btn"
                disabled={locked() || !draftText().trim()}
                onClick={() => void saveDraft()}
              >
                {t("feed.saveDraft")}
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.item.body}>
        {(body) => (
          <div class="wb-feed-body">
            <FeedMarkdown
              text={body()}
              class={bodyLong() && !bodyExpanded() ? "wb-feed-md--folded" : undefined}
            />
            <Show when={bodyLong()}>
              <button
                type="button"
                class="wb-feed-link-button"
                aria-expanded={bodyExpanded() ? "true" : "false"}
                onClick={() => setBodyExpanded(!bodyExpanded())}
              >
                {bodyExpanded() ? t("feed.less") : t("feed.more")}
              </button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.item.feed.links?.length}>
        <div class="wb-feed-links">
          <For each={props.item.feed.links} keyed={(link) => link.url}>
            {(link) => (
              <a class="wb-feed-chip" href={link().url} target="_blank" rel="noreferrer noopener">
                {icons.externalLink}
                <span>{link().label}</span>
              </a>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.item.comments.length}>
        <div class="wb-feed-thread">
          <Show when={hiddenComments() > 0}>
            <button
              type="button"
              class="wb-feed-link-button"
              onClick={() => setThreadExpanded(true)}
            >
              {t("feed.earlierComments", { count: String(hiddenComments()) })}
            </button>
          </Show>
          <For each={props.item.comments.slice(hiddenComments())} keyed={(entry) => entry.id}>
            {(entry) => (
              <div
                class={[
                  "wb-feed-comment",
                  { "wb-feed-comment--owner": entry().author?.kind === "owner" },
                ]}
              >
                <div class="wb-feed-comment__meta">
                  <span class="wb-feed-comment__author">{commentAuthor(entry())}</span>
                  <span>{formatTime(entry().createdAt, props.now)}</span>
                </div>
                <FeedMarkdown text={entry().body} />
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={commentOpen()}>
        <div class="wb-feed-composer">
          <textarea
            class="wb-feed-composer__input"
            rows="2"
            placeholder={t("feed.replyPlaceholder", { agent: agent() })}
            aria-label={t("feed.replyPlaceholder", { agent: agent() })}
            ref={(node) => {
              commentValue(node);
              node.value = commentText();
              focusLater(node);
            }}
            onInput={(event) => {
              setCommentText(event.currentTarget.value);
              autosize(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                comment();
              } else if (event.key === "Escape") {
                setCommentOpen(false);
              }
            }}
          />
          <div class="wb-feed-composer__actions">
            <span class="wb-feed-composer__hint">{t("feed.replyHint", { agent: agent() })}</span>
            <button type="button" class="btn btn--ghost" onClick={() => setCommentOpen(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              class="btn primary"
              disabled={locked() || !commentText().trim()}
              onClick={comment}
            >
              {pendingAction() === COMMENT ? (
                <span class="wb-feed-spinner" aria-hidden="true" />
              ) : (
                icons.send
              )}
              <span>{t("feed.sendReply")}</span>
            </button>
          </div>
        </div>
      </Show>
      <Show when={error()}>
        <p class="wb-feed-card__error" role="alert">
          {error()}
        </p>
      </Show>
      <footer class="wb-feed-card__actions">
        <div class="wb-feed-card__decisions">
          <For each={props.item.actions} keyed={(action) => action.id}>
            {(action, position) => {
              const primary = () =>
                action().style ? action().style === "primary" : position() === 0;
              const mine = () => pendingAction() === action().id;
              return (
                <button
                  type="button"
                  class={[
                    "btn",
                    {
                      primary: primary() || (decided() && mine()),
                      "wb-feed-confirmed": decided() && mine(),
                    },
                  ]}
                  disabled={locked()}
                  aria-busy={phase() === "pending" && mine() ? "true" : "false"}
                  onClick={() => act(action())}
                >
                  {phase() === "pending" && mine() ? (
                    <span class="wb-feed-spinner" aria-hidden="true" />
                  ) : decided() && mine() ? (
                    icons.check
                  ) : undefined}
                  <span>{decided() && mine() ? confirmedLabel() : action().label}</span>
                </button>
              );
            }}
          </For>
        </div>
        <div class="wb-feed-card__tools">
          <button
            type="button"
            class={["btn btn--ghost wb-feed-tool", { active: commentOpen() }]}
            aria-label={t("feed.comment")}
            title={t("feed.comment")}
            disabled={locked()}
            onClick={() => setCommentOpen(!commentOpen())}
          >
            {icons.messageSquare}
          </button>
          <button
            type="button"
            class="btn btn--ghost wb-feed-tool"
            aria-label={t("feed.doneHint")}
            title={t("feed.doneHint")}
            disabled={locked()}
            onClick={ack}
          >
            {phase() === "pending" && pendingAction() === ACK ? (
              <span class="wb-feed-spinner" aria-hidden="true" />
            ) : (
              icons.check
            )}
            <span class="wb-feed-tool__label">{t("feed.done")}</span>
          </button>
        </div>
      </footer>
    </article>
  );
}

function FeedPage(props: { feed: FeedStore; host: ControlUiHost; revision: number }) {
  const [held, setHeld] = createSignal<Held>(new Map());
  const [handledExpanded, setHandledExpanded] = createSignal(false);
  const [notice, setNotice] = createSignal<{ message: string; key: number; undo?: () => void }>({
    message: "",
    key: 0,
  });
  const view = createMemo(() => {
    void props.revision;
    const now = Date.now();
    // The store is a plain owner; each revision republishes its facts together.
    const { loaded, error, ownerName } = props.feed;
    return { now, loaded, error, ownerName, ...props.feed.view(now) };
  });
  const openCount = () => view().open.filter((item) => !held().has(item.card.id)).length;
  // Decided cards stay at their old position until their fold animation ends.
  const open = createMemo(() => {
    const items = view().open.filter((item) => !held().has(item.card.id));
    for (const entry of [...held().values()].toSorted((a, b) => a.index - b.index)) {
      items.splice(Math.min(entry.index, items.length), 0, entry.item);
    }
    return items;
  });
  const handled = createMemo(() => view().handled.filter((item) => !held().has(item.card.id)));
  const greeting = () => {
    const text = t(`feed.greeting.${feedGreeting(view().now)}`);
    return view().ownerName ? `${text}, ${view().ownerName}` : text;
  };
  const hold = (item: FeedItem, index: number) =>
    setHeld((current) => new Map(current).set(item.card.id, { item, index }));
  const release = (id: string) =>
    setHeld((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });

  return (
    <div class="wb-feed" role="region" aria-label={t("feed.title")}>
      <div class="wb-feed__inner">
        <header class="wb-feed__header">
          <div class="wb-feed__date">
            {new Date(view().now).toLocaleDateString(workboardLocale(), {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </div>
          <h1 class="wb-feed__greeting">{greeting()}</h1>
          <p class="wb-feed__subline">
            {!view().loaded
              ? t("feed.loading")
              : openCount() === 0
                ? t("feed.nothingNeedsYou")
                : openCount() === 1
                  ? t("feed.oneNeedsYou")
                  : t("feed.manyNeedYou", { count: String(openCount()) })}
          </p>
        </header>
        <Show when={view().error}>
          <div class="wb-feed__error" role="alert">
            <span>{view().error}</span>
            <button type="button" class="btn btn--sm" onClick={() => void props.feed.refresh()}>
              {t("common.retry")}
            </button>
          </div>
        </Show>
        <div class="wb-feed__list">
          <For each={open()} keyed={(item) => item.card.id}>
            {(item, index) => (
              <FeedCard
                item={item()}
                index={index()}
                now={view().now}
                host={props.host}
                feed={props.feed}
                hold={hold}
                release={release}
                notice={(message, undo) =>
                  setNotice((current) => ({ message, key: current.key + 1, undo }))
                }
              />
            )}
          </For>
        </div>
        <Show when={view().loaded && open().length === 0}>
          <div class="wb-feed__empty">
            <span class="wb-feed__empty-icon" aria-hidden="true">
              {icons.check}
            </span>
            <p>{t("feed.allCaughtUp")}</p>
          </div>
        </Show>
        <Show when={handled().length}>
          <section class="wb-feed-handled" aria-label={t("feed.handledToday")}>
            <h2 class="wb-feed-handled__title">
              {t("feed.handledToday")}
              <span>{handled().length}</span>
            </h2>
            <ul class="wb-feed-handled__list">
              <For
                each={handledExpanded() ? handled() : handled().slice(0, FEED_HANDLED_PREVIEW)}
                keyed={(item) => item.card.id}
              >
                {(item) => (
                  <li class="wb-feed-handled__row">
                    <span class="wb-feed-handled__check" aria-hidden="true">
                      {icons.check}
                    </span>
                    <span class="wb-feed-handled__label">{item().doneLabel}</span>
                    <span class="wb-feed-handled__time">
                      {formatTime(item().handledAt ?? view().now, view().now)}
                    </span>
                    <Show when={item().card.status !== "done"}>
                      <button
                        type="button"
                        class="btn btn--ghost wb-feed-tool wb-feed-handled__reopen"
                        aria-label={t("feed.reopen")}
                        title={t("feed.reopen")}
                        onClick={() => void props.feed.ack(item().card.id, false)}
                      >
                        {icons.undo}
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={handled().length > FEED_HANDLED_PREVIEW}>
              <button
                type="button"
                class="wb-feed-link-button"
                onClick={() => setHandledExpanded(!handledExpanded())}
              >
                {handledExpanded()
                  ? t("feed.less")
                  : t("feed.showAll", { count: String(handled().length) })}
              </button>
            </Show>
          </section>
        </Show>
      </div>
      <WorkboardToast
        message={notice().message}
        key={notice().key}
        action={(() => {
          const undo = notice().undo;
          return undo ? { label: t("feed.undo"), run: undo } : undefined;
        })()}
      />
    </div>
  );
}

export function createFeedPage(feed: FeedStore): ControlUiView {
  return (container, initialContext) => {
    const host = initialContext.host;
    let presented = initialContext.presented;
    const [revision, setRevision] = createSignal(0);
    const refresh = () => setRevision((value) => value + 1);
    const stops = [feed.subscribe(refresh), host.subscribe(refresh)];
    if (presented) {
      void feed.refresh();
    }
    const disposeRoot = render(
      () => <FeedPage feed={feed} host={host} revision={revision()} />,
      container,
    );
    return {
      update(next) {
        if (!presented && next.presented) {
          void feed.refresh();
        }
        presented = next.presented;
      },
      dispose() {
        stops.forEach((stop) => stop());
        disposeRoot();
      },
    };
  };
}
