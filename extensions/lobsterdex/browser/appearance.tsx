/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiAccessoryProps, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import { getLobsterdex, subscribeLobsterdex } from "./lobster-dex.js";
import { previewLobsterChirp } from "./lobster-pet-audio.js";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.js";
import { observeSource } from "./observe.js";

export const mountAppearance: ControlUiView<ControlUiAccessoryProps["ambient-appearance"]> = (
  container,
  initial,
) => {
  let current = initial;
  const [snapshot, setSnapshot] = createSignal({
    context: current,
    branding: current.host.presentation.branding,
  });
  const visits = document.createElement("div");
  const sounds = document.createElement("div");
  visits.style.display = sounds.style.display = "contents";
  const row = (kind: "visits" | "sounds") => {
    const { host, props } = current;
    const t = host.presentation.translate;
    const enabled = kind === "visits" ? props.visitsEnabled : props.soundsEnabled;
    const title = t(
      kind === "visits"
        ? "quickSettings.appearance.lobsterVisits"
        : "quickSettings.appearance.lobsterSounds",
    );
    let description = t(
      "quickSettings.appearance." +
        (kind === "visits" ? "lobsterVisits" : "lobsterSounds") +
        (enabled ? "On" : "Off"),
    );
    if (kind === "visits" && host.presentation.branding.mascot === "none") {
      description +=
        "\n" + t("quickSettings.appearance.lobsterVisitsThemeHidden", { theme: props.themeName });
    }
    return {
      title,
      description,
      checked: enabled,
      onChange: (checked: boolean) =>
        props.onChange(kind === "visits" ? { visitsEnabled: checked } : { soundsEnabled: checked }),
      onAct: (checked: boolean) => {
        if (kind === "sounds" && checked) {
          previewLobsterChirp();
        }
      },
    };
  };
  const visitControl = initial.host.components.mountToggleRow(visits, row("visits"));
  const soundControl = initial.host.components.mountToggleRow(sounds, row("sounds"));
  const publish = () => {
    setSnapshot({ context: current, branding: current.host.presentation.branding });
    visitControl.update(row("visits"));
    soundControl.update(row("sounds"));
  };
  const stop = initial.host.subscribe(publish);
  const dispose = render(() => {
    const dex = observeSource(getLobsterdex, subscribeLobsterdex);
    const t = (key: string, params?: Record<string, string>) =>
      snapshot().context.host.presentation.translate(key, params);
    return (
      <Show when={snapshot().branding.lobsterdex}>
        <section class="settings-section">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">{t("configView.appearance.tabIcon.lobster")}</h2>
          </div>
          <div class="settings-group">
            {visits}
            {sounds}
            <a
              class="settings-row settings-row--nav lobsterdex__open"
              href={snapshot().context.host.navigation.pageHref({ id: "collection" })}
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
                snapshot().context.host.navigation.openPage({ id: "collection" });
              }}
            >
              <span class="settings-row__text">
                <span class="settings-row__title">{t("quickSettings.appearance.lobsterdex")}</span>
                <span class="settings-row__desc">
                  {t("quickSettings.appearance.lobsterdexSeen", {
                    seen: String(
                      LOBSTER_PET_PALETTES.filter((palette) => dex().has(palette.id)).length,
                    ),
                    total: String(LOBSTER_PET_PALETTES.length),
                  })}
                </span>
              </span>
              <span class="settings-row__control">
                <span class="settings-row__chevron">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </span>
              </span>
            </a>
          </div>
        </section>
      </Show>
    );
  }, container);
  return {
    update(next) {
      current = next;
      publish();
    },
    dispose() {
      stop();
      visitControl.dispose();
      soundControl.dispose();
      dispose();
    },
  };
};

export default mountAppearance;
