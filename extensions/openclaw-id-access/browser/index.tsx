/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import {
  defineControlUiPlugin,
  type ControlUiDisposer,
  type ControlUiHost,
  type ControlUiView,
} from "openclaw/plugin-sdk/control-ui";
import { PeoplePage } from "./people-page.js";
import type { StatusResult } from "./types.js";
import "./control-ui.css";

/** The People destination in the Control UI sidebar's Pages catalog. */
export const PEOPLE_PAGE_ID = "people";

const mountPeople: ControlUiView = (container, context) => {
  const dispose = render(() => <PeoplePage host={context.host} />, container);
  return { dispose };
};

// The Gateway owns the flag and whether this connection may read people.
async function canSeePeople(host: ControlUiHost): Promise<boolean> {
  if (!host.connection.connected) {
    return false;
  }
  try {
    const status = await host.request<StatusResult>("openclawId.status", {});
    return status.status.state !== "off" && status.owner === true;
  } catch {
    return false;
  }
}

/**
 * Registers the owner-only People page and its sidebar destination while enabled.
 * Connection changes recheck the Gateway-owned flag and owner admission.
 */
export default defineControlUiPlugin({
  id: "openclaw-id-access",
  activate(host) {
    let disposePage: ControlUiDisposer | undefined;
    let generation = 0;
    const sync = async () => {
      const id = ++generation;
      const enabled = await canSeePeople(host);
      if (id !== generation || host.signal.aborted) {
        return;
      }
      if (enabled && !disposePage) {
        const page = host.ui.registerPage({
          id: PEOPLE_PAGE_ID,
          label: "People",
          mount: mountPeople,
        });
        const navigation = host.ui.registerNavigation({
          id: PEOPLE_PAGE_ID,
          label: "People",
          page: { id: PEOPLE_PAGE_ID },
          icon: "users",
          defaultVisible: false,
        });
        disposePage = () => {
          navigation();
          page();
        };
      } else if (!enabled && disposePage) {
        disposePage();
        disposePage = undefined;
      }
    };
    let connected = host.connection.connected;
    const unsubscribe = host.subscribe(() => {
      if (host.connection.connected !== connected) {
        connected = host.connection.connected;
        void sync();
      }
    });
    void sync();
    return () => {
      generation += 1;
      unsubscribe();
      disposePage?.();
    };
  },
});
