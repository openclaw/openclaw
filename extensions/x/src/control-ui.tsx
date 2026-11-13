/** @jsxImportSource @solidjs/web */
import { render, type JSX } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiView } from "openclaw/plugin-sdk/control-ui";
import {
  createMemo,
  createSignal,
  createStore,
  Errored,
  For,
  Loading,
  reconcile,
  Show,
} from "solid-js";
import type { XAllowlistSnapshot } from "./admin.js";
import "./control-ui.css";
import { createTranslator } from "./i18n/index.ts";

type Notice = "" | "added" | "removed" | "guestsBlocked" | "guestsOn" | "guestsOff";

type RepliesState = {
  accountId: string | undefined;
  snapshot: XAllowlistSnapshot | undefined;
  username: string;
  busy: boolean;
  notice: Notice;
  connected: boolean;
  canAdmin: boolean;
  locale: string;
};

const failureKinds = {
  "x.allowlist.list": "list",
  "x.allowlist.add": "add",
  "x.allowlist.remove": "remove",
  "x.guests.set": "guests",
} as const;

type RequestMethod = keyof typeof failureKinds;

/** Keeps the failed action for the summary; the server message stays secondary detail. */
class RequestFailure extends Error {
  readonly kind: (typeof failureKinds)[RequestMethod];
  constructor(kind: RequestFailure["kind"], cause: unknown) {
    super(cause instanceof Error ? cause.message : "", { cause });
    this.kind = kind;
  }
}

/** Places inline elements at `{name}` placeholders in translated copy. */
function withSlots(text: string, slots: Record<string, JSX.Element>): JSX.Element[] {
  return text
    .split(/\{(\w+)\}/)
    .map((part, index) => (index % 2 ? (slots[part] ?? `{${part}}`) : part));
}

type SnapshotIdentityFields = {
  accountId?: XAllowlistSnapshot["accountId"];
  userId?: XAllowlistSnapshot["entries"][number]["userId"];
  xUserId?: NonNullable<XAllowlistSnapshot["verifiedFromGitHub"]>["entries"][number]["xUserId"];
};

const mountXReplies: ControlUiView = (container, initialContext) => {
  const host = initialContext.host;
  let context = initialContext;
  let accountId: string | undefined;
  let snapshot: XAllowlistSnapshot | undefined;
  let username = "";
  let busy = false;
  let notice: Notice = "";
  let generation = 0;
  let disposed = false;
  let available = false;
  const [completion, setCompletion] = createSignal<Promise<void>>();
  // Request authority stays synchronous; the store only publishes presentation.
  const [view, setView] = createStore<RepliesState>({
    accountId,
    snapshot,
    username,
    busy,
    notice,
    connected: host.connection.connected,
    canAdmin: host.connection.canAdmin,
    locale: host.locale,
  });
  const t = createTranslator(() => view.locale);
  const canManage = () => host.connection.connected && host.connection.canAdmin;
  const usd = new Intl.NumberFormat(host.locale, {
    style: "currency",
    currency: "USD",
  });
  const dateTime = new Intl.DateTimeFormat(host.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const isCurrent = (id: number) =>
    !disposed && !context.signal.aborted && generation === id && canManage();

  function request(method: RequestMethod, params: Record<string, unknown> = {}) {
    if (busy || !canManage()) {
      return;
    }
    const id = ++generation;
    const selectedAccount = accountId;
    busy = true;
    notice = "";
    publish();
    const pending = (async () => {
      let result: XAllowlistSnapshot | undefined;
      try {
        result = await host.request<XAllowlistSnapshot>(method, {
          ...(selectedAccount ? { accountId: selectedAccount } : {}),
          ...params,
        });
        if (!isCurrent(id)) {
          return;
        }
        snapshot = result;
        accountId = result.accountId;
        if (method === "x.allowlist.add") {
          username = "";
          notice = "added";
        } else if (method === "x.allowlist.remove") {
          notice = "removed";
        } else if (method === "x.guests.set") {
          notice = result.guests.enabled
            ? result.guests.blockedReason
              ? "guestsBlocked"
              : "guestsOn"
            : "guestsOff";
        }
      } catch (cause) {
        if (isCurrent(id)) {
          throw new RequestFailure(failureKinds[method], cause);
        }
      } finally {
        if (isCurrent(id)) {
          busy = false;
          publish(result);
        }
      }
    })();
    void setCompletion(pending);
    // Errored consumes current failures; retired or disposed requests still need a consumer.
    void pending.catch(() => {});
  }

  function XReplies() {
    const completed = createMemo(() => completion()?.then(() => null) ?? null);
    return (
      <section class="x-replies" aria-labelledby="x-replies-title">
        <header class="x-replies__header">
          <div>
            <h1 id="x-replies-title">{t("xReplies.title")}</h1>
            <p>{t("xReplies.subtitle")}</p>
          </div>
          <button
            class="btn"
            type="button"
            disabled={view.busy || !view.connected || !view.canAdmin}
            onClick={() => request("x.allowlist.list")}
          >
            {t("xReplies.refresh")}
          </button>
        </header>
        {!view.connected ? (
          <p role="status">{t("xReplies.disconnected")}</p>
        ) : !view.canAdmin ? (
          <p role="status">{t("xReplies.adminRequired")}</p>
        ) : (
          <>
            <div class="x-replies__controls">
              <label class="x-replies__field">
                <span>{t("xReplies.agentAccount")}</span>
                <select
                  value={view.accountId ?? ""}
                  disabled={view.busy || !view.snapshot}
                  onChange={(event) => {
                    accountId = event.currentTarget.value;
                    snapshot = undefined;
                    request("x.allowlist.list");
                  }}
                >
                  <Show
                    when={view.snapshot}
                    fallback={
                      <option value={view.accountId ?? ""}>
                        {view.accountId ?? t("xReplies.selectAccount")}
                      </option>
                    }
                  >
                    {(currentSnapshot) => (
                      <For each={currentSnapshot().accounts} keyed={(row) => row.accountId}>
                        {(account) => (
                          <option
                            value={account().accountId}
                            selected={account().accountId === view.accountId}
                          >
                            {t("xReplies.accountOption", {
                              account: account().username
                                ? `@${account().username}`
                                : account().accountId,
                              accountId: account().accountId,
                            })}
                          </option>
                        )}
                      </For>
                    )}
                  </Show>
                </select>
              </label>
              <form
                class="x-replies__add"
                onSubmit={(event: Event) => {
                  event.preventDefault();
                  request("x.allowlist.add", { username });
                }}
              >
                <label class="x-replies__field">
                  <span>{t("xReplies.addByHandle")}</span>
                  <input
                    name="username"
                    autocomplete="off"
                    placeholder={t("xReplies.handlePlaceholder")}
                    maxlength="16"
                    required
                    value={view.username}
                    disabled={view.busy}
                    onInput={(event) => {
                      username = event.currentTarget.value;
                      publish();
                    }}
                  />
                </label>
                <button class="btn primary" type="submit" disabled={view.busy}>
                  {t("xReplies.addAccount")}
                </button>
              </form>
            </div>
            <p class="x-replies__hint">{t("xReplies.lookupHint")}</p>
            <Loading on={completion()}>
              <Errored
                fallback={(error) => {
                  const failure = () => {
                    const cause = error();
                    return cause instanceof RequestFailure ? cause : undefined;
                  };
                  return (
                    <p class="x-replies__error" role="alert">
                      {t(`xReplies.errors.${failure()?.kind ?? "list"}`)}
                      <Show when={failure()?.message}>
                        {(detail) => <small> {host.redact(detail())}</small>}
                      </Show>
                    </p>
                  );
                }}
              >
                {completed()}
              </Errored>
            </Loading>
            <div aria-live="polite">
              {view.busy ? (
                <p>{t("xReplies.updating")}</p>
              ) : view.notice ? (
                <p>{t(`xReplies.notices.${view.notice}`)}</p>
              ) : null}
            </div>
            <Show when={view.snapshot}>
              {(currentSnapshot) => (
                <>
                  <section class="x-replies__guests" aria-labelledby="x-guests-title">
                    <div class="x-replies__guest-header">
                      <div>
                        <h2 id="x-guests-title">{t("xReplies.guests.title")}</h2>
                        <p>{t("xReplies.guests.subtitle")}</p>
                      </div>
                      <button
                        class="x-replies__switch"
                        type="button"
                        role="switch"
                        aria-label={t("xReplies.guests.title")}
                        aria-checked={currentSnapshot().guests.enabled ? "true" : "false"}
                        disabled={view.busy}
                        onClick={() =>
                          request("x.guests.set", {
                            enabled: !currentSnapshot().guests.enabled,
                          })
                        }
                      >
                        <span class="x-replies__switch-track" aria-hidden="true"></span>
                        <span>
                          {t(
                            currentSnapshot().guests.enabled
                              ? "xReplies.guests.on"
                              : "xReplies.guests.off",
                          )}
                        </span>
                      </button>
                    </div>
                    <dl class="x-replies__guest-counts">
                      <div>
                        <dt>{t("xReplies.guests.perGuestLimit")}</dt>
                        <dd>{currentSnapshot().guests.maxMentionsPerAuthorPerDay}</dd>
                      </div>
                      <div>
                        <dt>{t("xReplies.guests.admittedToday")}</dt>
                        <dd>{currentSnapshot().guests.admittedToday}</dd>
                      </div>
                      <div>
                        <dt>{t("xReplies.guests.rateLimitedToday")}</dt>
                        <dd>{currentSnapshot().guests.rateLimitedToday}</dd>
                      </div>
                    </dl>
                    <p class="x-replies__hint">
                      {t("xReplies.guests.hint")}{" "}
                      <a
                        href="https://docs.openclaw.ai/channels/x#guest-mode"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("xReplies.guests.docsLink")}
                      </a>
                    </p>
                    {currentSnapshot().guests.blockedReason ? (
                      <p class="x-replies__error" role="alert">
                        {currentSnapshot().guests.blockedReason}
                      </p>
                    ) : null}
                  </section>
                  <dl class="x-replies__spend" aria-label={t("xReplies.spend.label")}>
                    <div>
                      <dt>{t("xReplies.spend.today")}</dt>
                      <dd>
                        <strong>{usd.format(currentSnapshot().spend.dayUsd)}</strong>
                        <span> / {usd.format(currentSnapshot().spend.dailyLimitUsd)}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {t("xReplies.spend.cycle", { date: currentSnapshot().spend.cycleStart })}
                      </dt>
                      <dd>
                        <strong>{usd.format(currentSnapshot().spend.cycleUsd)}</strong>
                        <span> / {usd.format(currentSnapshot().spend.monthlyLimitUsd)}</span>
                      </dd>
                    </div>
                  </dl>
                  <Show when={currentSnapshot().spend.exhaustedUntil}>
                    {(until) => (
                      <p class="x-replies__budget" role="status">
                        {withSlots(t("xReplies.spend.exhausted"), {
                          time: <time datetime={until()}>{until()}</time>,
                        })}
                      </p>
                    )}
                  </Show>
                  <div class="x-replies__list" aria-busy={view.busy ? "true" : "false"}>
                    {currentSnapshot().entries.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>{t("xReplies.allowlist.account")}</th>
                            <th>{t("xReplies.allowlist.source")}</th>
                            <th>{t("xReplies.allowlist.addedBy")}</th>
                            <th>
                              <span class="x-replies__sr-only">
                                {t("xReplies.allowlist.actions")}
                              </span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={currentSnapshot().entries}>
                            {(entry) => (
                              <tr>
                                <td>
                                  <strong>
                                    {entry.username ? `@${entry.username}` : entry.userId}
                                  </strong>
                                  {entry.name ? <span>{entry.name}</span> : null}
                                  {entry.username ? <small>{entry.userId}</small> : null}
                                </td>
                                <td>
                                  {t(
                                    entry.configured
                                      ? entry.editable
                                        ? "xReplies.allowlist.configAndStored"
                                        : "xReplies.allowlist.config"
                                      : "xReplies.allowlist.stored",
                                  )}
                                </td>
                                <td>{entry.addedBy ?? "—"}</td>
                                <td>
                                  {entry.editable ? (
                                    <button
                                      class="btn"
                                      type="button"
                                      aria-label={t("xReplies.allowlist.removeLabel", {
                                        account: entry.username
                                          ? `@${entry.username}`
                                          : entry.userId,
                                      })}
                                      disabled={view.busy}
                                      onClick={() =>
                                        request("x.allowlist.remove", {
                                          userId: entry.userId,
                                        })
                                      }
                                    >
                                      {t("xReplies.allowlist.remove")}
                                    </button>
                                  ) : (
                                    <span class="x-replies__hint">
                                      {t("xReplies.allowlist.readOnly")}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    ) : (
                      <p class="x-replies__empty">{t("xReplies.allowlist.empty")}</p>
                    )}
                  </div>
                  <Show when={currentSnapshot().verifiedFromGitHub}>
                    {(github) => {
                      const lastSync = createMemo(() => {
                        const timestamp = github().lastSyncAt;
                        return timestamp === undefined ? undefined : new Date(timestamp);
                      });
                      return (
                        <section class="x-replies__github" aria-labelledby="x-github-title">
                          <h2 id="x-github-title">{t("xReplies.github.title")}</h2>
                          <p>
                            {withSlots(t("xReplies.github.verifiedThrough"), {
                              repo: (
                                <a
                                  href={`https://github.com/${github().repo}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {github().repo}
                                </a>
                              ),
                            })}{" "}
                            <a
                              href="https://docs.openclaw.ai/channels/x#enable-yourself"
                              target="_blank"
                              rel="noreferrer"
                            >
                              {t("xReplies.github.profileSetup")}
                            </a>
                          </p>
                          <p class="x-replies__hint" role="status">
                            {github().stale ? `${t("xReplies.github.stale")} ` : ""}
                            <Show
                              when={lastSync()}
                              fallback={`${t("xReplies.github.neverSynced")} `}
                            >
                              {(date) => (
                                <>
                                  {withSlots(t("xReplies.github.lastSync"), {
                                    time: (
                                      <time datetime={date().toISOString()}>
                                        {dateTime.format(date())}
                                      </time>
                                    ),
                                  })}{" "}
                                  {github().stale
                                    ? `${t("xReplies.github.lastGoodSetActive")} `
                                    : ""}
                                </>
                              )}
                            </Show>
                            {t("xReplies.github.readOnly")}
                          </p>
                          <Show when={github().message}>
                            {(message) => (
                              <p class="x-replies__error" role="alert">
                                {host.redact(message())}
                              </p>
                            )}
                          </Show>
                          {github().unresolvedHandles.length ? (
                            <p class="x-replies__hint">
                              {t("xReplies.github.unresolved", {
                                handles: github()
                                  .unresolvedHandles.map((handle) => `@${handle}`)
                                  .join(", "),
                              })}
                            </p>
                          ) : null}
                          <div class="x-replies__list">
                            {github().entries.length ? (
                              <table>
                                <thead>
                                  <tr>
                                    <th>{t("xReplies.github.xAccount")}</th>
                                    <th>{t("xReplies.github.githubAccount")}</th>
                                    <th>{t("xReplies.github.permission")}</th>
                                    <th>{t("xReplies.github.lastSyncColumn")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <For each={github().entries}>
                                    {(entry) => (
                                      <tr>
                                        <td>
                                          <strong>@{entry.xHandle}</strong>
                                          <small>{entry.xUserId}</small>
                                        </td>
                                        <td>
                                          <a
                                            href={`https://github.com/${encodeURIComponent(entry.githubLogin)}`}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            @{entry.githubLogin}
                                          </a>
                                        </td>
                                        <td>{entry.permission}</td>
                                        <td>
                                          <time datetime={new Date(entry.syncedAt).toISOString()}>
                                            {dateTime.format(entry.syncedAt)}
                                          </time>
                                        </td>
                                      </tr>
                                    )}
                                  </For>
                                </tbody>
                              </table>
                            ) : (
                              <p class="x-replies__empty">{t("xReplies.github.empty")}</p>
                            )}
                          </div>
                        </section>
                      );
                    }}
                  </Show>
                  <p class="x-replies__hint">
                    {t(
                      currentSnapshot().guests.enabled
                        ? currentSnapshot().guests.blockedReason
                          ? "xReplies.footer.guestsBlocked"
                          : "xReplies.footer.guestsOn"
                        : "xReplies.footer.guestsOff",
                    )}
                  </p>
                </>
              )}
            </Show>
          </>
        )}
      </section>
    );
  }

  function publish(nextSnapshot?: XAllowlistSnapshot) {
    if (!disposed) {
      setView((current) => {
        if (nextSnapshot && current.snapshot?.accountId === nextSnapshot.accountId) {
          // These are the identities of account, manual, and GitHub rows in this snapshot.
          reconcile(
            nextSnapshot,
            (row: SnapshotIdentityFields) => row.accountId ?? row.userId ?? row.xUserId,
          )(current.snapshot);
        }
        return {
          accountId,
          snapshot,
          username,
          busy,
          notice,
          connected: host.connection.connected,
          canAdmin: host.connection.canAdmin,
          locale: host.locale,
        };
      });
    }
  }

  function sync() {
    const next = canManage() && context.presented;
    if (next !== available) {
      available = next;
      generation += 1;
      busy = false;
      snapshot = undefined;
      setCompletion(undefined);
      notice = "";
      if (next) {
        request("x.allowlist.list");
        return;
      }
    }
    publish();
  }
  const disposeRoot = render(() => <XReplies />, container);
  const unsubscribe = host.subscribe(sync);
  sync();
  return {
    update(next) {
      context = next;
      sync();
    },
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribe();
      disposeRoot();
    },
  };
};

export default defineControlUiPlugin({
  id: "x",
  activate(host) {
    const t = createTranslator(() => host.locale);
    const disposePage = host.ui.registerPage({
      id: "replies",
      label: t("xReplies.title"),
      mount: mountXReplies,
    });
    const disposeNavigation = host.ui.registerNavigation({
      id: "replies",
      label: t("xReplies.title"),
      page: { id: "replies" },
      icon: "at-sign",
      order: 40,
    });
    return () => {
      disposeNavigation();
      disposePage();
    };
  },
});
