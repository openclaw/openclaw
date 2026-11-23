/** @jsxImportSource @solidjs/web */
import "./styles/lobster-pet.css";
import "./styles/lobsterdex.css";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { lazyView } from "./lazy-view.js";
import { subscribeLobsterdex } from "./lobster-dex.js";
import { createTabIcons } from "./tab-icons.js";

export default defineControlUiPlugin({
  id: "lobsterdex",
  activate(host) {
    const page = host.ui.registerPage({
      id: "collection",
      label: "Lobsterdex",
      layout: "settings-wide",
      mount: lazyView(() => import("./collection-page.js")),
    });
    const visitors = host.ui.registerAccessory({
      id: "visitors",
      placement: "composer-decoration",
      mount: lazyView(() => import("./native-pet.js")),
    });
    const appearance = host.ui.registerAccessory({
      id: "appearance",
      placement: "ambient-appearance",
      mount: lazyView(() => import("./appearance.js")),
    });
    const memory = host.ui.registerAccessory({
      id: "memory",
      placement: "memory-scene",
      mount: lazyView(() => import("./memory-scene.js")),
    });
    const icons = host.ui.registerAccessory(createTabIcons(host));
    const stop = subscribeLobsterdex(host.ui.invalidate);
    return () => {
      stop();
      icons();
      memory();
      appearance();
      visitors();
      page();
    };
  },
});
