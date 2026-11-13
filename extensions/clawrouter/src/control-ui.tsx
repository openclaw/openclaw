/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, createStore, Errored, For, Loading } from "solid-js";
import type { ClawRouterPool, ClawRouterPoolResult } from "../pool.js";
import "./control-ui.css";
import { createTranslator } from "./i18n/index.ts";

type Grant = ClawRouterPool["grants"][number];
type Traffic = ClawRouterPool["usage"]["lanes"][number];
type TrafficMetric =
  | "requests"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "costMicros";
type ViewState = {
  result?: ClawRouterPoolResult;
  busy: boolean;
  connected: boolean;
  canRead: boolean;
};

const mountPool: ControlUiView = (container, initialContext) => {
  const host = initialContext.host;
  const t = createTranslator(() => host.locale);
  let context = initialContext;
  let result: ClawRouterPoolResult | undefined;
  let busy = false;
  let generation = 0;
  let available = false;
  let disposed = false;
  const [completion, setCompletion] = createSignal<Promise<void>>();
  const [view, setView] = createStore<ViewState>({
    busy,
    connected: host.connection.connected,
    canRead: host.connection.canRead,
  });
  const number = new Intl.NumberFormat(host.locale, { maximumFractionDigits: 1 });
  const integer = new Intl.NumberFormat(host.locale, { maximumFractionDigits: 0 });
  const usd = new Intl.NumberFormat(host.locale, { style: "currency", currency: "USD" });
  const dateTime = new Intl.DateTimeFormat(host.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const canRead = () => host.connection.connected && host.connection.canRead;
  const isCurrent = (id: number) =>
    !disposed && !context.signal.aborted && context.presented && generation === id && canRead();
  const notReported = () => t("clawrouter.values.notReported");
  const count = (value: number | undefined) =>
    value === undefined ? notReported() : integer.format(value);
  const cost = (value: number | undefined) =>
    value === undefined ? notReported() : usd.format(value / 1_000_000);
  const date = (value: string | undefined) =>
    value ? dateTime.format(new Date(value)) : notReported();
  const enabledState = (value: boolean) =>
    t(value ? "clawrouter.values.enabled" : "clawrouter.values.disabled");

  function sum(rows: readonly Traffic[], field: TrafficMetric): number | undefined {
    if (!rows.length) {
      return undefined;
    }
    let total = 0;
    for (const row of rows) {
      const value = row[field];
      if (value === undefined) {
        return undefined;
      }
      total += value;
    }
    return total;
  }

  function money(value: number | undefined, currency: string | undefined) {
    if (value === undefined) {
      return notReported();
    }
    if (currency) {
      try {
        const format = new Intl.NumberFormat(host.locale, { style: "currency", currency });
        const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
        return format.format(value / 10 ** digits);
      } catch {
        // An unknown currency still has a useful, unambiguous minor-unit value.
      }
    }
    const amount = integer.format(value);
    return currency
      ? t("clawrouter.values.minorUnitsWithCurrency", { amount, currency })
      : t("clawrouter.values.minorUnits", { amount });
  }

  function windowLabel(window: { window?: string; id?: string; models?: string[] | null }) {
    const value = window.window ?? window.id;
    if (!value) {
      return t("clawrouter.windows.fallback");
    }
    if (value === "5h" || value === "5_hour" || value === "five_hour") {
      return t("clawrouter.windows.fiveHour");
    }
    // ClawRouter scopes per-model weekly windows (for example Fable) to model families.
    const families = window.models?.filter(Boolean) ?? [];
    if (families.length) {
      const names = families.map((family) => family.charAt(0).toUpperCase() + family.slice(1));
      return t("clawrouter.windows.modelWeekly", { models: names.join(", ") });
    }
    if (value === "weekly" || value === "7d" || value === "seven_day") {
      return t("clawrouter.windows.weekly");
    }
    return value.replaceAll("_", " ");
  }

  const remaining = (value: number | undefined) =>
    value === undefined
      ? notReported()
      : t("clawrouter.values.percentFree", { value: number.format(value) });

  function refresh() {
    if (busy || !available) {
      return;
    }
    const id = ++generation;
    busy = true;
    publish();
    const pending = readPool(id);
    void setCompletion(pending);
    // The view can be retired before its admitted request settles.
    void pending.catch(() => undefined);
  }

  async function readPool(id: number) {
    try {
      const next = await host.request<ClawRouterPoolResult>("clawrouter.pool.get");
      if (isCurrent(id)) {
        result = next;
      }
    } catch (cause) {
      if (isCurrent(id)) {
        // The message is technical detail shown below the fixed next step.
        throw new Error(host.redact(cause instanceof Error ? cause.message : ""), { cause });
      }
    } finally {
      if (isCurrent(id)) {
        busy = false;
        publish();
      }
    }
  }

  function TrafficStats(props: { rows: readonly Traffic[] }) {
    return (
      <dl class="clawrouter-pool__stats clawrouter-pool__traffic">
        <div>
          <dt>{t("clawrouter.traffic.requests")}</dt>
          <dd>{count(sum(props.rows, "requests"))}</dd>
        </div>
        <div>
          <dt>{t("clawrouter.traffic.inputTokens")}</dt>
          <dd>{count(sum(props.rows, "inputTokens"))}</dd>
        </div>
        <div>
          <dt>{t("clawrouter.traffic.outputTokens")}</dt>
          <dd>{count(sum(props.rows, "outputTokens"))}</dd>
        </div>
        <div>
          <dt>{t("clawrouter.traffic.cacheReadTokens")}</dt>
          <dd>{count(sum(props.rows, "cacheReadTokens"))}</dd>
        </div>
        <div>
          <dt>{t("clawrouter.traffic.cacheWriteTokens")}</dt>
          <dd>{count(sum(props.rows, "cacheWriteTokens"))}</dd>
        </div>
        <div>
          <dt>{t("clawrouter.traffic.apiValue")}</dt>
          <dd>{cost(sum(props.rows, "costMicros"))}</dd>
        </div>
      </dl>
    );
  }

  function GrantCard(props: { grant: Grant; pool: ClawRouterPool; index: number }) {
    const traffic = createMemo(() => {
      const key = props.grant.key;
      const provider = props.grant.provider;
      if (!key || !provider) {
        return [];
      }
      const grantKey = key.split("/").at(-1);
      return props.pool.usage.grants.filter(
        (row) => row.grantKey === grantKey && row.provider === provider,
      );
    });
    return (
      <article class="clawrouter-pool__grant" aria-labelledby={`clawrouter-grant-${props.index}`}>
        <header class="clawrouter-pool__grant-header">
          <div>
            <h3 id={`clawrouter-grant-${props.index}`}>
              {props.grant.label ??
                props.grant.account?.email ??
                props.grant.key ??
                t("clawrouter.grant.subscription")}
            </h3>
            <p class="clawrouter-pool__hint">
              {[props.grant.provider, props.grant.kind].filter(Boolean).join(" · ")}
            </p>
          </div>
          <span class="clawrouter-pool__badge">
            {props.grant.enabled === undefined
              ? t("clawrouter.values.enabledNotReported")
              : enabledState(props.grant.enabled)}
          </span>
        </header>
        <dl class="clawrouter-pool__stats">
          <div>
            <dt>{t("clawrouter.grant.account")}</dt>
            <dd>{props.grant.account?.email ?? notReported()}</dd>
          </div>
          <div>
            <dt>{t("clawrouter.grant.plan")}</dt>
            <dd>{props.grant.plan ?? notReported()}</dd>
          </div>
          <div>
            <dt>{t("clawrouter.grant.credential")}</dt>
            <dd>{props.grant.credentialStatus ?? notReported()}</dd>
          </div>
          <div>
            <dt>{t("clawrouter.grant.subscription")}</dt>
            <dd>{props.grant.account?.subscriptionStatus ?? notReported()}</dd>
          </div>
          <div>
            <dt>{t("clawrouter.grant.rateLimitTier")}</dt>
            <dd>{props.grant.account?.rateLimitTier ?? notReported()}</dd>
          </div>
          <div>
            <dt>{t("clawrouter.grant.lastSelected")}</dt>
            <dd>{date(props.grant.lastSelectedAt)}</dd>
          </div>
        </dl>
        <section class="clawrouter-pool__section" aria-label={t("clawrouter.grant.quotaLabel")}>
          <h4>{t("clawrouter.grant.quotaTitle")}</h4>
          {props.grant.windows.length ? (
            <div class="clawrouter-pool__windows">
              <For each={props.grant.windows}>
                {(window) => (
                  <div class="clawrouter-pool__window">
                    <div class="clawrouter-pool__window-heading">
                      <strong>{windowLabel(window)}</strong>
                      <span>{remaining(window.remainingPercent)}</span>
                    </div>
                    {window.remainingPercent !== undefined ? (
                      <progress
                        max="100"
                        value={window.remainingPercent}
                        aria-label={t("clawrouter.grant.quotaRemaining", {
                          window: windowLabel(window),
                        })}
                      />
                    ) : null}
                    <p class="clawrouter-pool__hint">
                      {window.models === null
                        ? t("clawrouter.grant.allModels")
                        : window.models?.join(", ") || t("clawrouter.grant.modelScopeNotReported")}
                    </p>
                    <p class="clawrouter-pool__hint">
                      {t("clawrouter.grant.resets", { date: date(window.resetAt) })}
                    </p>
                    {window.observedAt ? (
                      <p class="clawrouter-pool__hint">
                        {t("clawrouter.pool.observed", { date: date(window.observedAt) })}
                      </p>
                    ) : null}
                  </div>
                )}
              </For>
            </div>
          ) : (
            <p class="clawrouter-pool__hint">{t("clawrouter.grant.noQuotaWindows")}</p>
          )}
        </section>
        <section class="clawrouter-pool__section" aria-label={t("clawrouter.grant.extraUsage")}>
          <h4>{t("clawrouter.grant.extraUsage")}</h4>
          {props.grant.extraUsage ? (
            <>
              <p>
                {props.grant.extraUsage.enabled === undefined
                  ? t("clawrouter.values.enabledNotReported")
                  : enabledState(props.grant.extraUsage.enabled)}
                {" · "}
                {t("clawrouter.grant.extraUsageSpend", {
                  used: money(props.grant.extraUsage.usedCredits, props.grant.extraUsage.currency),
                  limit: money(
                    props.grant.extraUsage.monthlyLimit,
                    props.grant.extraUsage.currency,
                  ),
                })}
              </p>
              {props.grant.extraUsage.spendLimitReached ? (
                <p class="clawrouter-pool__warning">{t("clawrouter.grant.spendLimitReached")}</p>
              ) : null}
            </>
          ) : (
            <p class="clawrouter-pool__hint">{notReported()}</p>
          )}
        </section>
        <section
          class="clawrouter-pool__section"
          aria-label={t("clawrouter.grant.eligibilityLabel")}
        >
          <h4>{t("clawrouter.grant.eligibilityTitle")}</h4>
          {props.pool.models.length ? (
            <ul class="clawrouter-pool__models">
              <For each={props.pool.models}>
                {(model) => (
                  <li>
                    <span>{model}</span>
                    <span class="clawrouter-pool__badge">
                      {props.grant.eligibility[model]?.replaceAll("_", " ") ?? notReported()}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          ) : (
            <p class="clawrouter-pool__hint">{t("clawrouter.grant.noModels")}</p>
          )}
        </section>
        <section class="clawrouter-pool__section" aria-label={t("clawrouter.grant.trafficLabel")}>
          <h4>{t("clawrouter.grant.trafficTitle")}</h4>
          <TrafficStats rows={traffic()} />
          <p class="clawrouter-pool__hint">
            {t("clawrouter.grant.selections", { count: count(props.grant.selectedCount) })}
          </p>
        </section>
      </article>
    );
  }

  function PoolContent(props: { pool: ClawRouterPool }) {
    const subscriptions = () =>
      props.pool.grants.filter((grant) => grant.kind === "subscription" || grant.kind === "oauth");
    const paidFallback = () =>
      props.pool.usage.lanes.filter(
        (lane) => lane.grantLane === "api_key" || lane.grantLane === "environment",
      );
    const eligible = (model: string) =>
      subscriptions().filter(
        (grant) => grant.enabled !== false && grant.eligibility[model] === "eligible",
      ).length;
    const unknown = (model: string) =>
      subscriptions().filter((grant) => grant.enabled !== false && !grant.eligibility[model])
        .length;
    return (
      <>
        <p class="clawrouter-pool__hint">
          {props.pool.policyId
            ? t("clawrouter.pool.observedWithPolicy", {
                date: date(props.pool.observedAt),
                policy: props.pool.policyId,
              })
            : t("clawrouter.pool.observed", { date: date(props.pool.observedAt) })}
        </p>
        <section class="clawrouter-pool__summary" aria-labelledby="clawrouter-summary-title">
          <h2 id="clawrouter-summary-title">{t("clawrouter.summary.title")}</h2>
          <dl class="clawrouter-pool__stats">
            <div>
              <dt>{t("clawrouter.summary.subscriptions")}</dt>
              <dd>{integer.format(subscriptions().length)}</dd>
            </div>
            <div>
              <dt>{t("clawrouter.summary.routingStrategy")}</dt>
              <dd>{props.pool.routing?.strategy ?? notReported()}</dd>
            </div>
            <div>
              <dt>{t("clawrouter.summary.includedQuotaReserve")}</dt>
              <dd>
                {props.pool.routing?.includedQuotaReservePercent === undefined
                  ? notReported()
                  : t("clawrouter.values.percent", {
                      value: number.format(props.pool.routing.includedQuotaReservePercent),
                    })}
              </dd>
            </div>
            <div>
              <dt>{t("clawrouter.summary.environmentFallback")}</dt>
              <dd>
                {props.pool.routing?.environmentFallback === undefined
                  ? notReported()
                  : enabledState(props.pool.routing.environmentFallback)}
              </dd>
            </div>
            <div>
              <dt>{t("clawrouter.summary.paidFallbackRequests")}</dt>
              <dd>{count(sum(paidFallback(), "requests"))}</dd>
            </div>
            <div>
              <dt>{t("clawrouter.summary.paidFallbackValue")}</dt>
              <dd>{cost(sum(paidFallback(), "costMicros"))}</dd>
            </div>
          </dl>
          <p class="clawrouter-pool__hint">{t("clawrouter.summary.paidFallbackHint")}</p>
          <h3>{t("clawrouter.summary.modelsTitle")}</h3>
          <p class="clawrouter-pool__hint">{t("clawrouter.summary.modelsHint")}</p>
          {props.pool.models.length ? (
            <ul class="clawrouter-pool__models">
              <For each={props.pool.models}>
                {(model) => (
                  <li>
                    <span>{model}</span>
                    <span>
                      {unknown(model)
                        ? t("clawrouter.summary.modelHeadroomWithUnknown", {
                            count: integer.format(eligible(model)),
                            unknown: integer.format(unknown(model)),
                          })
                        : t("clawrouter.summary.modelHeadroom", {
                            count: integer.format(eligible(model)),
                          })}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          ) : (
            <p>{t("clawrouter.summary.noModels")}</p>
          )}
          <h3>
            {props.pool.usage.days === undefined
              ? t("clawrouter.summary.trafficTitle")
              : t("clawrouter.summary.trafficTitleWithDays", {
                  days: number.format(props.pool.usage.days),
                })}
          </h3>
          <p class="clawrouter-pool__hint">{t("clawrouter.summary.trafficHint")}</p>
          {props.pool.usage.lanes.length ? (
            <div class="clawrouter-pool__lanes">
              <For each={props.pool.usage.lanes}>
                {(lane) => (
                  <section class="clawrouter-pool__lane">
                    <h4>
                      {[lane.provider, lane.grantLane].filter(Boolean).join(" · ") ||
                        t("clawrouter.summary.unspecifiedLane")}
                    </h4>
                    <TrafficStats rows={[lane]} />
                  </section>
                )}
              </For>
            </div>
          ) : (
            <p class="clawrouter-pool__hint">{t("clawrouter.summary.noTraffic")}</p>
          )}
        </section>
        <section aria-labelledby="clawrouter-subscriptions-title">
          <h2 id="clawrouter-subscriptions-title">{t("clawrouter.summary.grantsTitle")}</h2>
          {props.pool.grants.length ? (
            <div class="clawrouter-pool__grants">
              <For each={props.pool.grants}>
                {(grant, index) => <GrantCard grant={grant} pool={props.pool} index={index()} />}
              </For>
            </div>
          ) : (
            <p class="clawrouter-pool__empty">{t("clawrouter.summary.noGrants")}</p>
          )}
        </section>
      </>
    );
  }

  function PoolPage() {
    const completed = createMemo(() => completion()?.then(() => null) ?? null);
    return (
      <section
        class="clawrouter-pool"
        aria-labelledby="clawrouter-pool-title"
        aria-busy={view.busy ? "true" : "false"}
      >
        <header class="clawrouter-pool__header">
          <div>
            <h1 id="clawrouter-pool-title">ClawRouter</h1>
            <p>{t("clawrouter.pool.subtitle")}</p>
          </div>
          <button
            class="clawrouter-pool__refresh"
            type="button"
            disabled={view.busy || !view.connected || !view.canRead}
            onClick={() => refresh()}
          >
            {view.busy ? t("common.refreshing") : t("common.refresh")}
          </button>
        </header>
        {!view.connected ? (
          <p class="clawrouter-pool__empty" role="status">
            {t("clawrouter.pool.disconnected")}
          </p>
        ) : !view.canRead ? (
          <p class="clawrouter-pool__empty" role="status">
            {t("clawrouter.pool.readAccessRequired")}
          </p>
        ) : (
          <>
            <Loading on={completion()}>
              <Errored
                fallback={(error) => {
                  const detail = () => {
                    const failure = error();
                    return failure instanceof Error ? failure.message : String(failure);
                  };
                  // No shared disclosure exists for plugin views; raw detail stays secondary.
                  return (
                    <>
                      <p class="clawrouter-pool__error" role="alert">
                        {t("clawrouter.pool.loadFailed")}
                      </p>
                      {detail() ? <p class="clawrouter-pool__hint">{detail()}</p> : null}
                    </>
                  );
                }}
              >
                {completed()}
                {!view.result && !view.busy ? (
                  <p class="clawrouter-pool__empty">{t("clawrouter.pool.notLoaded")}</p>
                ) : null}
              </Errored>
            </Loading>
            {view.busy ? (
              <p class="clawrouter-pool__hint" role="status">
                {t("clawrouter.pool.loading")}
              </p>
            ) : null}
            {view.result?.status === "ok" ? (
              <PoolContent pool={view.result.pool} />
            ) : view.result ? (
              <p class="clawrouter-pool__empty" role="status">
                {host.redact(view.result.message)}
              </p>
            ) : null}
          </>
        )}
      </section>
    );
  }

  function publish() {
    if (!disposed) {
      setView(() => ({
        result,
        busy,
        connected: host.connection.connected,
        canRead: host.connection.canRead,
      }));
    }
  }

  function sync() {
    const next = canRead() && context.presented && !context.signal.aborted;
    if (next !== available) {
      available = next;
      generation += 1;
      busy = false;
      result = undefined;
      setCompletion(undefined);
      if (next) {
        refresh();
        return;
      }
    }
    publish();
  }
  const disposeRoot = render(() => <PoolPage />, container);
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
  id: "clawrouter",
  activate(host) {
    const disposePage = host.ui.registerPage({ id: "pool", label: "ClawRouter", mount: mountPool });
    const disposeNavigation = host.ui.registerNavigation({
      id: "pool",
      label: "ClawRouter",
      page: { id: "pool" },
      icon: "layers",
      order: 45,
    });
    return () => {
      disposeNavigation();
      disposePage();
    };
  },
});
