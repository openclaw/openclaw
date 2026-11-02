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
  onNavigate: (tab: "memories" | "dreams" | "settings") => void;
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
  const { SettingsSection, SettingsRow, SettingsStatus, SettingsValue, SettingsNavRow, Lobster } =
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
              : hasEmbeddingError(payload)
                ? (payload.embedding.error ?? t("memoryPage.overview.health.unavailable"))
                : t("memoryPage.overview.hero.activeDescription", {
                    engine: engineId() ?? t("common.unknown"),
                    mode: searchMode(payload),
                  })
            : t("memoryPage.overview.hero.loadingDescription");
    };
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
      <section class={["memory-overview__hero", { "memory-overview__hero--sleeping": off() }]}>
        <div class="memory-overview__lobster">
          <Lobster seed={props.agentId ?? "memory"} {...pose()} />
        </div>
        <div class="memory-overview__hero-copy">
          <h2>{headline()}</h2>
          <p class={{ "memory-overview__hero-error": error() }}>{description()}</p>
          <div class="memory-overview__hero-actions">
            {off() ? (
              <button class="btn btn--sm" onClick={() => props.onNavigate("settings")}>
                {t("memoryPage.overview.hero.openSettings")}
              </button>
            ) : (
              <button class="btn btn--sm" onClick={() => props.onRefresh()}>
                {props.status.kind === "error"
                  ? t("memoryPage.overview.hero.retry")
                  : t("memoryPage.overview.hero.refresh")}
              </button>
            )}
          </div>
        </div>
      </section>
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
    const phases = createMemo(
      () =>
        [
          ["light", props.dreaming.phases.light],
          ["rem", props.dreaming.phases.rem],
          ["deep", props.dreaming.phases.deep],
        ] as const,
    );
    return (
      <SettingsSection title={t("memoryPage.overview.schedule.title")}>
        <>
          <For each={phases()} keyed={(entry) => entry[0]}>
            {(entry) => (
              <SettingsRow
                title={t(`memoryPage.dreaming.phases.${entry()[0]}.title`)}
                description={
                  <>
                    {t(`memoryPage.overview.schedule.${entry()[0]}Description`)}
                    <br />
                    {phaseScheduleDescription(
                      entry()[1],
                      props.dreaming.timezone,
                      props.dreaming.enabled && entry()[1].enabled && entry()[1].managedCronPresent,
                    )}
                  </>
                }
                control={
                  <SettingsStatus
                    kind={
                      props.dreaming.enabled && entry()[1].enabled && entry()[1].managedCronPresent
                        ? "ok"
                        : "muted"
                    }
                    label={
                      !props.dreaming.enabled || !entry()[1].enabled
                        ? t("common.disabled")
                        : entry()[1].managedCronPresent
                          ? t("common.enabled")
                          : t("memoryPage.overview.schedule.notScheduled")
                    }
                  />
                }
              />
            )}
          </For>
          <SettingsRow
            title={t("memoryPage.overview.schedule.learnMore")}
            control={
              <>
                {" "}
                <a
                  class="memory-page__link"
                  href="https://docs.openclaw.ai/concepts/dreaming"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t("memoryPage.overview.schedule.openDocs")}
                </a>{" "}
              </>
            }
          />
        </>
      </SettingsSection>
    );
  }

  function Activity(props: { dreaming: DreamingStatus }) {
    const rows = createMemo(
      () =>
        [
          ["promotedToday", props.dreaming.promotedToday],
          ["promotedTotal", props.dreaming.promotedTotal],
          ["shortTermCount", props.dreaming.shortTermCount],
          ["phaseHitCount", props.dreaming.phaseSignalCount],
          ["lightPhaseHitCount", props.dreaming.lightPhaseHitCount],
          ["remPhaseHitCount", props.dreaming.remPhaseHitCount],
        ] as const,
    );
    return (
      <SettingsSection title={t("memoryPage.overview.activity.title")}>
        <For each={rows()} keyed={(entry) => entry[0]}>
          {(entry) => (
            <SettingsRow
              title={t(`memoryPage.overview.activity.${entry()[0]}`)}
              control={<SettingsValue value={entry()[1]} />}
            />
          )}
        </For>
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
      <SettingsSection title={t("memoryPage.overview.health.title")}>
        <>
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
        </>
      </SettingsSection>
    );
  }

  function StatusCards(props: MemoryOverviewProps) {
    const payload = createMemo(() => (props.status.kind === "ready" ? props.status.payload : null));
    return (
      <Show when={payload()}>
        {(current) => (
          <>
            <Show when={current().dreaming}>
              {(dreaming) => (
                <>
                  <Schedule dreaming={dreaming()} />
                  <Activity dreaming={dreaming()} />
                </>
              )}
            </Show>
            {current().searchRuntimeRegistered !== false && (
              <EngineHealth payload={current()} overview={props} />
            )}
          </>
        )}
      </Show>
    );
  }

  function Shortcuts(props: MemoryOverviewProps) {
    return (
      <SettingsSection title={t("memoryPage.overview.shortcuts.title")}>
        <For
          each={
            [
              ["memories", "memoryPage.overview.shortcuts.memories"],
              ["dreams", "memoryPage.overview.shortcuts.diary"],
              ["settings", "memoryPage.overview.shortcuts.settings"],
            ] as const
          }
          keyed={(entry) => entry[0]}
        >
          {(entry) => (
            <SettingsNavRow title={t(entry()[1])} onClick={() => props.onNavigate(entry()[0])} />
          )}
        </For>
      </SettingsSection>
    );
  }

  function MemoryOverview(props: MemoryOverviewProps) {
    return (
      <div class="settings-page memory-overview">
        <Hero {...props} />{" "}
        {props.engineSelection.kind !== "off" && !props.engineDisabled ? (
          <StatusCards {...props} />
        ) : undefined}{" "}
        <Shortcuts {...props} />
      </div>
    );
  }

  return MemoryOverview;
}
