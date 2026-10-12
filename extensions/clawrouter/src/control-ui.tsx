/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createStore, For } from "solid-js";
import type { ClawRouterPool, ClawRouterPoolResult } from "../pool.js";
import "./control-ui.css";

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
  error: string;
  connected: boolean;
  canRead: boolean;
};

const mountPool: ControlUiView = (container, initialContext) => {
  const host = initialContext.host;
  let context = initialContext;
  let result: ClawRouterPoolResult | undefined;
  let busy = false;
  let error = "";
  let generation = 0;
  let available = false;
  let disposed = false;
  const [view, setView] = createStore<ViewState>({
    busy,
    error,
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
  const count = (value: number | undefined) =>
    value === undefined ? "Not reported" : integer.format(value);
  const cost = (value: number | undefined) =>
    value === undefined ? "Not reported" : usd.format(value / 1_000_000);
  const date = (value: string | undefined) =>
    value ? dateTime.format(new Date(value)) : "Not reported";

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
      return "Not reported";
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
    return `${integer.format(value)} minor units${currency ? ` (${currency})` : ""}`;
  }

  function windowLabel(value: string | undefined) {
    if (!value) {
      return "Quota window";
    }
    if (value === "5h" || value === "5_hour" || value === "five_hour") {
      return "5-hour";
    }
    if (value === "weekly" || value === "7d") {
      return "Weekly";
    }
    return value.replaceAll("_", " ");
  }

  const remaining = (value: number | undefined) =>
    value === undefined ? "Not reported" : `${number.format(value)}% free`;

  async function refresh() {
    if (busy || !available) {
      return;
    }
    const id = ++generation;
    busy = true;
    error = "";
    publish();
    try {
      const next = await host.request<ClawRouterPoolResult>("clawrouter.pool.get");
      if (isCurrent(id)) {
        result = next;
      }
    } catch (cause) {
      if (isCurrent(id)) {
        error = host.redact(
          cause instanceof Error ? cause.message : "Could not load the pool. Try refreshing.",
        );
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
          <dt>Requests</dt>
          <dd>{count(sum(props.rows, "requests"))}</dd>
        </div>
        <div>
          <dt>Input tokens</dt>
          <dd>{count(sum(props.rows, "inputTokens"))}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{count(sum(props.rows, "outputTokens"))}</dd>
        </div>
        <div>
          <dt>Cache read tokens</dt>
          <dd>{count(sum(props.rows, "cacheReadTokens"))}</dd>
        </div>
        <div>
          <dt>Cache write tokens</dt>
          <dd>{count(sum(props.rows, "cacheWriteTokens"))}</dd>
        </div>
        <div>
          <dt>API-equivalent value</dt>
          <dd>{cost(sum(props.rows, "costMicros"))}</dd>
        </div>
      </dl>
    );
  }

  function GrantCard(props: { grant: Grant; pool: ClawRouterPool; index: number }) {
    const traffic = () =>
      props.grant.key && props.grant.provider
        ? props.pool.usage.grants.filter(
            (row) =>
              row.grantKey === props.grant.key?.split("/").at(-1) &&
              row.provider === props.grant.provider,
          )
        : [];
    return (
      <article class="clawrouter-pool__grant" aria-labelledby={`clawrouter-grant-${props.index}`}>
        <header class="clawrouter-pool__grant-header">
          <div>
            <h3 id={`clawrouter-grant-${props.index}`}>
              {props.grant.label ?? props.grant.account?.email ?? props.grant.key ?? "Subscription"}
            </h3>
            <p class="clawrouter-pool__hint">
              {[props.grant.provider, props.grant.kind].filter(Boolean).join(" · ")}
            </p>
          </div>
          <span class="clawrouter-pool__badge">
            {props.grant.enabled === undefined
              ? "Enabled state unknown"
              : props.grant.enabled
                ? "Enabled"
                : "Disabled"}
          </span>
        </header>
        <dl class="clawrouter-pool__stats">
          <div>
            <dt>Account</dt>
            <dd>{props.grant.account?.email ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{props.grant.plan ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Credential</dt>
            <dd>{props.grant.credentialStatus ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Subscription</dt>
            <dd>{props.grant.account?.subscriptionStatus ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Rate-limit tier</dt>
            <dd>{props.grant.account?.rateLimitTier ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Last selected</dt>
            <dd>{date(props.grant.lastSelectedAt)}</dd>
          </div>
        </dl>
        <section class="clawrouter-pool__section" aria-label="Subscription quota windows">
          <h4>Quota headroom</h4>
          {props.grant.windows.length ? (
            <div class="clawrouter-pool__windows">
              <For each={props.grant.windows}>
                {(window) => (
                  <div class="clawrouter-pool__window">
                    <div class="clawrouter-pool__window-heading">
                      <strong>{windowLabel(window.window ?? window.id)}</strong>
                      <span>{remaining(window.remainingPercent)}</span>
                    </div>
                    {window.remainingPercent !== undefined ? (
                      <progress
                        max="100"
                        value={window.remainingPercent}
                        aria-label={`${windowLabel(window.window ?? window.id)} quota remaining`}
                      />
                    ) : null}
                    <p class="clawrouter-pool__hint">
                      {window.models === null
                        ? "All models"
                        : window.models?.join(", ") || "Model scope not reported"}
                    </p>
                    <p class="clawrouter-pool__hint">Resets {date(window.resetAt)}</p>
                    {window.observedAt ? (
                      <p class="clawrouter-pool__hint">Observed {date(window.observedAt)}</p>
                    ) : null}
                  </div>
                )}
              </For>
            </div>
          ) : (
            <p class="clawrouter-pool__hint">No quota windows reported.</p>
          )}
        </section>
        <section class="clawrouter-pool__section" aria-label="Extra usage">
          <h4>Extra usage</h4>
          {props.grant.extraUsage ? (
            <>
              <p>
                {props.grant.extraUsage.enabled === undefined
                  ? "Enabled state not reported"
                  : props.grant.extraUsage.enabled
                    ? "Enabled"
                    : "Disabled"}
                {" · "}
                {money(props.grant.extraUsage.usedCredits, props.grant.extraUsage.currency)} used
                {" / "}
                {money(props.grant.extraUsage.monthlyLimit, props.grant.extraUsage.currency)}{" "}
                monthly limit
              </p>
              {props.grant.extraUsage.spendLimitReached ? (
                <p class="clawrouter-pool__warning">Spend limit reached</p>
              ) : null}
            </>
          ) : (
            <p class="clawrouter-pool__hint">Not reported.</p>
          )}
        </section>
        <section class="clawrouter-pool__section" aria-label="Per-model eligibility">
          <h4>Model eligibility</h4>
          {props.pool.models.length ? (
            <ul class="clawrouter-pool__models">
              <For each={props.pool.models}>
                {(model) => (
                  <li>
                    <span>{model}</span>
                    <span class="clawrouter-pool__badge">
                      {props.grant.eligibility[model]?.replaceAll("_", " ") ?? "Not reported"}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          ) : (
            <p class="clawrouter-pool__hint">No allowed models reported.</p>
          )}
        </section>
        <section class="clawrouter-pool__section" aria-label="Subscription traffic">
          <h4>Traffic</h4>
          <TrafficStats rows={traffic()} />
          <p class="clawrouter-pool__hint">
            Selections: {count(props.grant.selectedCount)}. API-equivalent value is not a
            subscription charge.
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
          Observed {date(props.pool.observedAt)}
          {props.pool.policyId ? ` · Policy ${props.pool.policyId}` : ""}
        </p>
        <section class="clawrouter-pool__summary" aria-labelledby="clawrouter-summary-title">
          <h2 id="clawrouter-summary-title">Pool summary</h2>
          <dl class="clawrouter-pool__stats">
            <div>
              <dt>Subscriptions</dt>
              <dd>{integer.format(subscriptions().length)}</dd>
            </div>
            <div>
              <dt>Routing strategy</dt>
              <dd>{props.pool.routing?.strategy ?? "Not reported"}</dd>
            </div>
            <div>
              <dt>Included quota reserve</dt>
              <dd>
                {props.pool.routing?.includedQuotaReservePercent === undefined
                  ? "Not reported"
                  : `${number.format(props.pool.routing.includedQuotaReservePercent)}%`}
              </dd>
            </div>
            <div>
              <dt>Environment fallback</dt>
              <dd>
                {props.pool.routing?.environmentFallback === undefined
                  ? "Not reported"
                  : props.pool.routing.environmentFallback
                    ? "Enabled"
                    : "Disabled"}
              </dd>
            </div>
            <div>
              <dt>Paid fallback requests</dt>
              <dd>{count(sum(paidFallback(), "requests"))}</dd>
            </div>
            <div>
              <dt>Paid fallback value</dt>
              <dd>{cost(sum(paidFallback(), "costMicros"))}</dd>
            </div>
          </dl>
          <p class="clawrouter-pool__hint">
            Paid fallback aggregates API-key and environment lanes, including direct paid traffic.
            Values are API-equivalent USD.
          </p>
          <h3>Allowed models and headroom</h3>
          <p class="clawrouter-pool__hint">
            Eligibility reported by ClawRouter includes quota reserves and credential health.
          </p>
          {props.pool.models.length ? (
            <ul class="clawrouter-pool__models">
              <For each={props.pool.models}>
                {(model) => (
                  <li>
                    <span>{model}</span>
                    <span>
                      {integer.format(eligible(model))} subscriptions with headroom
                      {unknown(model) ? ` · ${integer.format(unknown(model))} unknown` : ""}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          ) : (
            <p>No allowed models reported for this policy.</p>
          )}
          <h3>
            Pool traffic
            {props.pool.usage.days === undefined
              ? ""
              : ` · last ${number.format(props.pool.usage.days)} days`}
          </h3>
          <p class="clawrouter-pool__hint">
            Paid fallback is shown by its reported lane. API-equivalent values are in USD.
          </p>
          {props.pool.usage.lanes.length ? (
            <div class="clawrouter-pool__lanes">
              <For each={props.pool.usage.lanes}>
                {(lane) => (
                  <section class="clawrouter-pool__lane">
                    <h4>
                      {[lane.provider, lane.grantLane].filter(Boolean).join(" · ") ||
                        "Unspecified lane"}
                    </h4>
                    <TrafficStats rows={[lane]} />
                  </section>
                )}
              </For>
            </div>
          ) : (
            <p class="clawrouter-pool__hint">No traffic reported.</p>
          )}
        </section>
        <section aria-labelledby="clawrouter-subscriptions-title">
          <h2 id="clawrouter-subscriptions-title">Subscriptions and grants</h2>
          {props.pool.grants.length ? (
            <div class="clawrouter-pool__grants">
              <For each={props.pool.grants}>
                {(grant, index) => <GrantCard grant={grant} pool={props.pool} index={index()} />}
              </For>
            </div>
          ) : (
            <p class="clawrouter-pool__empty">No subscriptions are reported for this policy.</p>
          )}
        </section>
      </>
    );
  }

  function PoolPage() {
    return (
      <section
        class="clawrouter-pool"
        aria-labelledby="clawrouter-pool-title"
        aria-busy={view.busy ? "true" : "false"}
      >
        <header class="clawrouter-pool__header">
          <div>
            <h1 id="clawrouter-pool-title">ClawRouter</h1>
            <p>Subscription headroom, model access, and traffic for your configured policy.</p>
          </div>
          <button
            class="clawrouter-pool__refresh"
            type="button"
            disabled={view.busy || !view.connected || !view.canRead}
            onClick={() => void refresh()}
          >
            {view.busy ? "Refreshing…" : "Refresh"}
          </button>
        </header>
        {!view.connected ? (
          <p class="clawrouter-pool__empty" role="status">
            Connect to the Gateway to view the ClawRouter pool.
          </p>
        ) : !view.canRead ? (
          <p class="clawrouter-pool__empty" role="status">
            Read access is required to view the ClawRouter pool.
          </p>
        ) : (
          <>
            {view.error ? (
              <p class="clawrouter-pool__error" role="alert">
                {view.error}
              </p>
            ) : null}
            {view.busy ? (
              <p class="clawrouter-pool__hint" role="status">
                Loading the latest pool status…
              </p>
            ) : null}
            {view.result?.status === "ok" ? (
              <PoolContent pool={view.result.pool} />
            ) : view.result ? (
              <p class="clawrouter-pool__empty" role="status">
                {host.redact(view.result.message)}
              </p>
            ) : !view.busy && !view.error ? (
              <p class="clawrouter-pool__empty">Refresh to load pool status.</p>
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
        error,
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
      error = "";
      if (next) {
        void refresh();
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
