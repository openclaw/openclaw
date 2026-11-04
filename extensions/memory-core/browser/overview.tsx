/** @jsxImportSource @solidjs/web */
import type {
  DoctorMemoryStatusPayload,
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createMemo, For, Show } from "solid-js";
import { createSettingsComponents } from "./components.tsx";
import { createTranslator } from "./i18n/index.ts";
import "./overview.css";

export type MemoryOverviewStatus =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; payload: DoctorMemoryStatusPayload }
  | { kind: "error"; message: string };

type MemoryOverviewProps = {
  agentId: string | null;
  engineSelection: ControlUiSettingsSnapshot["engine"];
  engineDisabled: boolean;
  status: MemoryOverviewStatus;
  probingEmbeddings: boolean;
  onRefresh: () => void;
  onProbeEmbeddings: () => void;
  onNavigate: (tab: "settings") => void;
};

type DreamingStatus = NonNullable<DoctorMemoryStatusPayload["dreaming"]>;
type DreamingPhase = DreamingStatus["phases"][keyof DreamingStatus["phases"]] & {
  lastRunAtMs?: number;
};

export function createMemoryOverview(
  context: ControlUiSettingsContext,
  snapshot: () => ControlUiSettingsSnapshot,
) {
  const t = createTranslator(() => snapshot().locale);
  const formatRelativeTimestamp = context.formatRelativeTimestamp;
  const { SettingsSection, SettingsRows, SettingsRow, SettingsStatus, SettingsValue, Lobster } =
    createSettingsComponents(context.components);

  function hasEmbeddingError(payload: DoctorMemoryStatusPayload): boolean {
    return !payload.embedding.ok && payload.embedding.checked !== false;
  }

  function searchMode(payload: DoctorMemoryStatusPayload): string {
    return payload.provider === "none"
      ? t("memoryPage.overview.hero.keywordSearch")
      : t("memoryPage.overview.hero.hybridSearch");
  }

  function Hero(props: MemoryOverviewProps) {
    const engineId = () => props.engineSelection.id;
    const off = createMemo(() => props.engineSelection.kind === "off" || props.engineDisabled);
    const readyPayload = createMemo(() =>
      props.status.kind === "ready" ? props.status.payload : null,
    );
    const noSearchRuntime = () => readyPayload()?.searchRuntimeRegistered === false;
    const error = () => {
      const payload = readyPayload();
      return (
        props.status.kind === "error" ||
        (!noSearchRuntime() && payload !== null && hasEmbeddingError(payload))
      );
    };
    const headline = () =>
      off()
        ? t("memoryPage.overview.hero.hibernating")
        : props.status.kind === "loading" || props.status.kind === "idle"
          ? t("memoryPage.overview.hero.waking")
          : noSearchRuntime()
            ? t("memoryPage.overview.hero.noSearchRuntime")
            : error()
              ? t("memoryPage.overview.hero.needsAttention")
              : t("memoryPage.overview.hero.awake");
    const description = () => {
      const payload = readyPayload();
      return off()
        ? t(
            props.engineDisabled
              ? "memoryPage.overview.hero.disabledDescription"
              : "memoryPage.overview.hero.offDescription",
          )
        : props.status.kind === "error"
          ? props.status.message
          : payload
            ? noSearchRuntime()
              ? t("memoryPage.overview.hero.noSearchRuntimeDescription", {
                  engine: engineId() ?? t("common.unknown"),
                })
              : t("memoryPage.overview.hero.activeDescription", {
                  engine: engineId() ?? t("common.unknown"),
                  mode: searchMode(payload),
                })
            : t("memoryPage.overview.hero.loadingDescription");
    };
    const retrying = () => props.status.kind === "error";
    const pose = createMemo(() =>
      off()
        ? { sleeping: true }
        : error()
          ? { grumpy: true, standalone: true }
          : readyPayload() && !noSearchRuntime()
            ? { reading: true, standalone: true }
            : { standalone: true },
    );
    return (
      <div class={["memory-overview__status", { "memory-overview__status--sleeping": off() }]}>
        <div class="memory-overview__lobster">
          <Lobster seed={props.agentId ?? "memory"} {...pose()} />
        </div>
        <div class="memory-overview__status-copy">
          <h2>{headline()}</h2>
          {/* An embedding failure reads once, on its own row below. */}
          <p class={{ "memory-overview__status-error": props.status.kind === "error" }}>
            {description()}
          </p>
        </div>
        <div class="memory-overview__status-action">
          {off() ? (
            <button class="btn btn--sm" onClick={() => props.onNavigate("settings")}>
              {t("memoryPage.overview.hero.openSettings")}
            </button>
          ) : (
            <button
              type="button"
              class={retrying() ? "btn btn--sm" : "btn btn--icon btn--ghost refresh-button"}
              aria-label={retrying() ? undefined : t("memoryPage.overview.hero.refresh")}
              onClick={() => props.onRefresh()}
            >
              {retrying() ? (
                t("memoryPage.overview.hero.retry")
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  function phaseScheduleDescription(
    phase: DreamingPhase,
    timezone: string | undefined,
    scheduled: boolean,
  ) {
    const details = [
      phase.cron || t("common.na"),
      timezone,
      scheduled && phase.nextRunAtMs
        ? t("memoryPage.overview.schedule.nextRun", {
            time: formatRelativeTimestamp(phase.nextRunAtMs),
          })
        : null,
      phase.lastRunAtMs
        ? t("memoryPage.overview.schedule.lastRun", {
            time: formatRelativeTimestamp(phase.lastRunAtMs),
          })
        : null,
    ].filter((entry): entry is string => Boolean(entry));
    return details.join(" · ");
  }

  function Schedule(props: { dreaming: DreamingStatus }) {
    // One sweep runs the phases in this order.
    const phases = createMemo(() =>
      (
        [
          ["light", props.dreaming.phases.light],
          ["rem", props.dreaming.phases.rem],
          ["deep", props.dreaming.phases.deep],
        ] as const
      ).map(([id, phase]) => ({
        id,
        phase,
        scheduled: props.dreaming.enabled && phase.enabled && phase.managedCronPresent,
        details: phaseScheduleDescription(
          phase,
          props.dreaming.timezone,
          props.dreaming.enabled && phase.enabled && phase.managedCronPresent,
        ),
      })),
    );
    // A single sweep gives all three the same cadence, so it reads once, above them.
    const sharedDetails = createMemo(() => {
      const [first, ...rest] = phases();
      return first && rest.every((entry) => entry.details === first.details) ? first.details : null;
    });
    return (
      <SettingsSection title={t("memoryPage.overview.schedule.title")}>
        <>
          <Show when={sharedDetails()}>
            {(details) => (
              <SettingsRow
                title={t("memoryPage.overview.schedule.sweep")}
                description={
                  <span>
                    {details()} <GuideLink />
                  </span>
                }
              />
            )}
          </Show>
          <For each={phases()} keyed={(entry) => entry.id}>
            {(entry) => (
              <SettingsRow
                title={t(`memoryPage.dreaming.phases.${entry().id}.title`)}
                description={sharedDetails() ? undefined : entry().details}
                control={
                  <SettingsStatus
                    kind={entry().scheduled ? "ok" : "muted"}
                    label={
                      !props.dreaming.enabled || !entry().phase.enabled
                        ? t("common.disabled")
                        : entry().phase.managedCronPresent
                          ? t("common.enabled")
                          : t("memoryPage.overview.schedule.notScheduled")
                    }
                  />
                }
              />
            )}
          </For>
          <Show when={!sharedDetails()}>
            <SettingsRow title={t("memoryPage.overview.schedule.guide")} control={<GuideLink />} />
          </Show>
        </>
      </SettingsSection>
    );
  }

  function GuideLink() {
    return (
      <a
        class="learn-more-link"
        href="https://docs.openclaw.ai/concepts/dreaming"
        target="_blank"
        rel="noreferrer noopener"
      >
        {t("memoryPage.overview.schedule.learnMore")}
      </a>
    );
  }

  function Activity(props: { dreaming: DreamingStatus }) {
    return (
      <SettingsSection title={t("memoryPage.overview.activity.title")}>
        <>
          <SettingsRow
            title={t("memoryPage.overview.activity.promoted")}
            control={
              <SettingsValue
                value={t("memoryPage.overview.activity.promotedValue", {
                  today: String(props.dreaming.promotedToday),
                  total: String(props.dreaming.promotedTotal),
                })}
              />
            }
          />
          <SettingsRow
            title={t("memoryPage.overview.activity.shortTermCount")}
            control={<SettingsValue value={props.dreaming.shortTermCount} />}
          />
          <SettingsRow
            title={t("memoryPage.overview.activity.phaseHitCount")}
            control={
              <SettingsValue
                value={t("memoryPage.overview.activity.phaseHitValue", {
                  light: String(props.dreaming.lightPhaseHitCount),
                  rem: String(props.dreaming.remPhaseHitCount),
                })}
              />
            }
          />
        </>
      </SettingsSection>
    );
  }

  function EngineHealth(props: {
    payload: DoctorMemoryStatusPayload;
    overview: MemoryOverviewProps;
  }) {
    const notChecked = createMemo(() => props.payload.embedding.checked === false);
    const embeddingKind = () =>
      props.payload.embedding.ok ? "ok" : notChecked() ? "muted" : "danger";
    const embeddingLabel = () =>
      props.overview.probingEmbeddings
        ? t("memoryPage.overview.health.checking")
        : props.payload.embedding.ok
          ? t("memoryPage.overview.health.healthy")
          : notChecked()
            ? t("memoryPage.overview.health.notChecked")
            : t("memoryPage.overview.health.unavailable");
    return (
      <SettingsRows>
        <SettingsRow
          title={t("memoryPage.overview.health.provider")}
          control={
            <SettingsValue mono={true} value={props.payload.provider ?? t("common.unknown")} />
          }
        />
        <SettingsRow
          title={t("memoryPage.overview.health.embeddings")}
          description={
            props.payload.embedding.ok
              ? undefined
              : notChecked()
                ? t("memoryPage.overview.health.notCheckedDescription")
                : props.payload.embedding.error
          }
          control={
            <>
              <SettingsStatus kind={embeddingKind()} label={embeddingLabel()} />
              {notChecked() ? (
                <>
                  {" "}
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={props.overview.probingEmbeddings}
                    onClick={() => props.overview.onProbeEmbeddings()}
                  >
                    {props.overview.probingEmbeddings
                      ? t("memoryPage.overview.health.testing")
                      : t("memoryPage.overview.health.test")}
                  </button>{" "}
                </>
              ) : undefined}
            </>
          }
        />
        {props.payload.embeddingRuntime ? (
          <SettingsRow
            title={t("memoryPage.overview.health.runtime")}
            description={props.payload.embeddingRuntime.loadError}
            control={
              <SettingsValue
                value={[
                  props.payload.embeddingRuntime.engine,
                  props.payload.embeddingRuntime.backend,
                  props.payload.embeddingRuntime.buildInfo,
                  props.payload.embeddingRuntime.model?.id,
                  props.payload.embeddingRuntime.endpoints
                    ? Object.entries(props.payload.embeddingRuntime.endpoints)
                        .map(([name, state]) => `${name}=${state}`)
                        .join(" ")
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            }
          />
        ) : undefined}
      </SettingsRows>
    );
  }

  function DreamingSections(props: MemoryOverviewProps) {
    const payload = createMemo(() => (props.status.kind === "ready" ? props.status.payload : null));
    return (
      <Show when={payload()}>
        {(current) => (
          <Show when={current().dreaming}>
            {(dreaming) => (
              <>
                <Schedule dreaming={dreaming()} />
                <Activity dreaming={dreaming()} />
              </>
            )}
          </Show>
        )}
      </Show>
    );
  }

  function HealthRows(props: MemoryOverviewProps) {
    const payload = createMemo(() => (props.status.kind === "ready" ? props.status.payload : null));
    return (
      <Show when={payload()}>
        {(current) =>
          current().searchRuntimeRegistered !== false && (
            <EngineHealth payload={current()} overview={props} />
          )
        }
      </Show>
    );
  }

  function MemoryOverview(props: MemoryOverviewProps) {
    const running = () => props.engineSelection.kind !== "off" && !props.engineDisabled;
    return (
      <div class="settings-page memory-overview">
        <div class="settings-group">
          <Hero {...props} />
          {running() ? <HealthRows {...props} /> : undefined}
        </div>
        {running() ? <DreamingSections {...props} /> : undefined}
      </div>
    );
  }

  return MemoryOverview;
}
