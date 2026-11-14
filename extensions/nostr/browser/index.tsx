/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiChannelSettingsView } from "openclaw/plugin-sdk/control-ui";
import { createSignal } from "solid-js";
import { createProfileController } from "./controller.ts";
import { createTranslator } from "./i18n/index.ts";
import { loadMessages } from "./i18n/locales.ts";
import { createProfileCard } from "./profile.tsx";

export const pluginId = "nostr";
export const settingsViews: readonly ControlUiChannelSettingsView[] = [
  {
    placement: { section: "channels", panel: "detail", channelId: "nostr" },
    mount(container, context) {
      void loadMessages(context.props.locale);
      // The controller is synchronous; this projection stops publishing while the modal is hidden.
      const [state, setState] = createSignal<
        ReturnType<ReturnType<typeof createProfileController>["read"]>
      >({ snapshot: context.props, form: null, accountId: null }, { ownedWrite: true });
      const controller = createProfileController(
        context,
        () => {
          const next = controller.read();
          if (next.snapshot.presented) {
            setState(next);
          }
        },
        createTranslator(() => controller.read().snapshot.locale),
      );
      const Profile = createProfileCard(context, state, controller);
      const stop = render(() => <Profile />, container);
      return {
        update(snapshot) {
          void loadMessages(snapshot.locale);
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
];
