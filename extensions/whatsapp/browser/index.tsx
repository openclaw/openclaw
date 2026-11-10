/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiChannelSettingsView } from "openclaw/plugin-sdk/control-ui";
import { createSignal } from "solid-js";
import { loadMessages } from "./i18n/locales.ts";
import { WhatsAppCard } from "./settings.tsx";

export const pluginId = "whatsapp";
export const settingsViews: readonly ControlUiChannelSettingsView[] = [
  {
    placement: { section: "channels", panel: "detail", channelId: "whatsapp" },
    mount(container, context) {
      void loadMessages(context.props.locale);
      const [snapshot, setSnapshot] = createSignal(context.props, { ownedWrite: true });
      const stop = render(
        () => <WhatsAppCard context={context} snapshot={snapshot()} />,
        container,
      );
      return {
        update(next) {
          if (next.presented) {
            void loadMessages(next.locale);
            setSnapshot(next);
          }
        },
        // The application login owner also serves setup; detaching this view never resets it.
        dispose: stop,
      };
    },
  },
];
