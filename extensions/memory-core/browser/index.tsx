/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiSettingsView } from "openclaw/plugin-sdk/control-ui";
import { createSignal } from "solid-js";
import { createMemoryOverviewController } from "./controller.ts";
import { createTranslator } from "./i18n/index.ts";
import { memoriesView } from "./memories.tsx";
import { createMemoryOverview } from "./overview.tsx";

export const pluginId = "memory-core";
export const settingsViews: readonly ControlUiSettingsView[] = [
  {
    placement: { section: "memory", panel: "overview" },
    mount(container, context) {
      // Only this imperative view lifetime writes its reactive projection.
      const [state, setState] = createSignal<
        ReturnType<ReturnType<typeof createMemoryOverviewController>["read"]>
      >(
        { snapshot: context.props, status: { kind: "idle" }, probingEmbeddings: false },
        { ownedWrite: true },
      );
      const t = createTranslator(() => state().snapshot.locale);
      const controller = createMemoryOverviewController(
        context,
        () => setState(controller.read()),
        () => t("memoryPage.overview.hero.gatewayOffline"),
      );
      const MemoryOverview = createMemoryOverview(context, () => state().snapshot);
      const stop = render(
        () => (
          <MemoryOverview
            agentId={state().snapshot.agentId}
            engineSelection={state().snapshot.engine}
            engineDisabled={state().snapshot.engine.availability === "disabled"}
            status={
              state().snapshot.agentId
                ? state().status
                : state().snapshot.agentsError
                  ? { kind: "error", message: state().snapshot.agentsError! }
                  : state().status
            }
            probingEmbeddings={state().probingEmbeddings}
            onRefresh={() => controller.refresh()}
            onProbeEmbeddings={() => controller.probe()}
            onNavigate={context.navigate}
          />
        ),
        container,
      );
      void controller.load();
      return {
        update(snapshot) {
          controller.update(snapshot);
        },
        dispose() {
          try {
            controller.dispose();
          } finally {
            stop();
          }
        },
      };
    },
  },
  memoriesView,
];
