import type { ControlUiHost, ControlUiTabIconAccessory } from "openclaw/plugin-sdk/control-ui";
import { lazyView } from "./lazy-view.js";
import { getLobsterdex } from "./lobster-dex.js";
import { lobsterPaletteName } from "./lobster-pet-lore.js";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.js";

export function tabIconPalettes(host: ControlUiHost) {
  const known = getLobsterdex();
  return host.presentation.branding.lobsterdex
    ? LOBSTER_PET_PALETTES.filter((palette) => known.has(palette.id))
    : [];
}

export function createTabIcons(host: ControlUiHost): ControlUiTabIconAccessory {
  const choices = () => tabIconPalettes(host);
  const selected = (value: string) =>
    choices().find((palette) => value === "lobster:" + palette.id);
  return {
    id: "tab-icons",
    placement: "tab-icon",
    prefix: "lobster:",
    accepts: (value) => Boolean(selected(value)),
    describe(value) {
      const palette = selected(value);
      const available = choices();
      const visible = host.presentation.branding.lobsterdex;
      return {
        selected: Boolean(palette),
        hasChoices: available.length > 0,
        label: palette && lobsterPaletteName(palette.id),
        detail:
          visible && (palette || value.startsWith("lobster:") || available.length === 0)
            ? host.presentation.translate(
                palette
                  ? "configView.appearance.tabIcon.localCollection"
                  : value.startsWith("lobster:")
                    ? "configView.appearance.tabIcon.unavailable"
                    : available.length === 0
                      ? "configView.appearance.tabIcon.empty"
                      : "",
              )
            : undefined,
      };
    },
    async loadImage(value) {
      if (!host.presentation.branding.lobsterdex || !value.startsWith("lobster:")) {
        return null;
      }
      const { loadUnlockedLobsterFavicon } = await import("./lobster-favicon.js");
      return loadUnlockedLobsterFavicon(value.slice(8));
    },
    mount: lazyView(() => import("./tab-icon-view.js")),
  };
}
