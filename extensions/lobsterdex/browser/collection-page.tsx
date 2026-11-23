/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiView, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { getLobsterdexEntries, subscribeLobsterdex } from "./lobster-dex.js";
import { LobsterSvg } from "./lobster-pet-artwork.js";
import { canonicalLobsterLook, lobsterLookStyle } from "./lobster-pet-identity.js";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "./lobster-pet-lore.js";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.js";
import { observeSource } from "./observe.js";

const COLLECTION_COPY: Record<string, string> = {
  "tabs.lobsterdex": "Lobsterdex",
  "tabs.appearance": "Appearance",
  "subtitles.lobsterdex": "Every lobster palette that has visited this browser.",
  "quickSettings.appearance.lobsterdexSeen": "{seen}/{total} visited",
  "quickSettings.appearance.lobsterdexCardFirstVisited": "First visited {date}",
  "quickSettings.appearance.lobsterdexCardShinySeen": "✦ Shiny spotted {date}",
  "quickSettings.appearance.lobsterdexThemeHidden":
    "This theme hides Lobsterdex. Your collection and preferences are preserved.",
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-lobsterdex-page": HTMLAttributes<HTMLElement>;
    }
  }
}

export function LobsterdexPage(props: { host: ControlUiHost }) {
  let host!: HTMLElement;
  const cards = new Map<string, HTMLElement>();
  const presentation = createMemo(() => {
    const service = props.host;
    return observeSource(
      () => ({ branding: service.presentation.branding, locale: service.locale }),
      service.subscribe,
    );
  });
  const entries = observeSource(getLobsterdexEntries, subscribeLobsterdex);
  const t = (key: string, params?: Record<string, string>) => {
    presentation()();
    const translated = props.host.presentation.translate(key, params);
    if (translated !== key) {
      return translated;
    }
    let fallback = COLLECTION_COPY[key] ?? key;
    for (const [name, value] of Object.entries(params ?? {})) {
      fallback = fallback.replaceAll("{" + name + "}", value);
    }
    return fallback;
  };
  const formatLobsterdexDate = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString(presentation()().locale);
  const seenCount = createMemo(
    () => LOBSTER_PET_PALETTES.filter((palette) => entries().has(palette.id)).length,
  );
  const countLabel = () =>
    t("quickSettings.appearance.lobsterdexSeen", {
      seen: String(seenCount()),
      total: String(LOBSTER_PET_PALETTES.length),
    });
  onSettled(() => {
    const card = cards.get(location.hash);
    if (!card || !host.contains(card)) {
      return undefined;
    }
    card.classList.add("lobsterdex-page__card--highlight");
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => card.scrollIntoView({ block: "center" }));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  });

  function LobsterdexView(view: { entries: ReturnType<typeof getLobsterdexEntries> }) {
    return (
      <section class="lobsterdex-page">
        <section class="lobsterdex-page__grid" aria-label={countLabel()}>
          <For each={LOBSTER_PET_PALETTES}>
            {(palette) => {
              const look = canonicalLobsterLook(palette);
              const entry = createMemo(() => view.entries.get(palette.id));
              const firstSeen = createMemo(() => {
                const timestamp = entry()?.firstSeenAt;
                return timestamp != null
                  ? t("quickSettings.appearance.lobsterdexCardFirstVisited", {
                      date: formatLobsterdexDate(timestamp),
                    })
                  : null;
              });
              const shinySeen = createMemo(() => {
                const timestamp = entry()?.shinySeenAt;
                return timestamp != null
                  ? t("quickSettings.appearance.lobsterdexCardShinySeen", {
                      date: formatLobsterdexDate(timestamp),
                    })
                  : null;
              });
              return (
                <article
                  onAnimationEnd={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      event.animationName === "lobsterdex-card-highlight"
                    ) {
                      event.currentTarget.classList.remove("lobsterdex-page__card--highlight");
                    }
                  }}
                  id={`lobsterdex-${palette.id}`}
                  ref={(element) => cards.set(`#lobsterdex-${palette.id}`, element)}
                  class={["lobsterdex-page__card", { "lobsterdex-page__card--unseen": !entry() }]}
                >
                  <div
                    class={[
                      "lobsterdex-page__sprite",
                      "lobster-pet",
                      `lobster-pet--palette-${palette.id}`,
                      { "lobsterdex__mini--unseen": !entry() },
                    ]}
                    style={lobsterLookStyle(look)}
                  >
                    <LobsterSvg look={look} standalone />
                    {entry()?.shinySeenAt != null && (
                      <span class="lobsterdex__mini-star lobsterdex-page__star" aria-hidden="true">
                        ✦
                      </span>
                    )}
                  </div>
                  <h3>{entry() ? (entry()?.name ?? lobsterPaletteName(palette.id)) : "?"}</h3>
                  <p class="lobsterdex-page__lore">
                    {entry()
                      ? LOBSTER_PALETTE_LORE[palette.id].flavor
                      : LOBSTER_PALETTE_LORE[palette.id].hint}
                  </p>
                  <div class="lobsterdex-page__dates">
                    {firstSeen() && (
                      <p class="lobsterdex-page__date">
                        <time>{firstSeen()}</time>
                      </p>
                    )}
                    {shinySeen() && (
                      <p class="lobsterdex-page__date">
                        <time>{shinySeen()}</time>
                      </p>
                    )}
                  </div>
                </article>
              );
            }}
          </For>
        </section>
      </section>
    );
  }

  return (
    <openclaw-lobsterdex-page ref={(element) => (host = element)}>
      <section
        class={[
          "content-header content-header--settings",
          { "content-header--intro": presentation()().branding.lobsterdex },
        ]}
      >
        <div>
          <h1 class="page-title">{t("tabs.lobsterdex")}</h1>
          <Show when={presentation()().branding.lobsterdex}>
            <div class="page-subtitle">{t("subtitles.lobsterdex")}</div>
          </Show>
        </div>
        <Show when={presentation()().branding.lobsterdex}>
          <div class="page-header-actions">
            <span
              class={[
                "lobsterdex-page__count",
                { "lobsterdex-page__count--complete": seenCount() === LOBSTER_PET_PALETTES.length },
              ]}
            >
              {countLabel()}
            </span>
          </div>
        </Show>
      </section>
      <section class="settings-workspace">
        <div class="settings-workspace__body">
          <div class="settings-page settings-page--wide">
            {presentation()().branding.lobsterdex ? (
              <LobsterdexView entries={entries()} />
            ) : (
              <section class="settings-section" role="status">
                <p>{t("quickSettings.appearance.lobsterdexThemeHidden")}</p>
                <a
                  class="btn btn--sm"
                  href={props.host.basePath + "/settings/appearance"}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    props.host.navigation.openSettings("appearance");
                  }}
                >
                  {t("tabs.appearance")}
                </a>
              </section>
            )}
          </div>
        </div>
      </section>
    </openclaw-lobsterdex-page>
  );
}

export const mountCollection: ControlUiView = (container, initial) => {
  const [context, setContext] = createSignal(initial);
  const dispose = render(() => <LobsterdexPage host={context().host} />, container);
  return { update: setContext, dispose };
};

export default mountCollection;
