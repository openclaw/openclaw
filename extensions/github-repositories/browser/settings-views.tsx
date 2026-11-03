/** @jsxImportSource @solidjs/web */

import type {
  ControlUiSettingsContextV2,
  ControlUiContributionSettingsSnapshot as ControlUiSettingsSnapshot,
  ControlUiContributedSettingsView as ControlUiSettingsView,
} from "openclaw/plugin-sdk/control-ui";
import { createSignal, onSettled, untrack } from "solid-js";
import {
  GitHubConnections,
  createIdentityDependencies,
  type SettingsSource,
} from "./github-connections.tsx";
import { GitHubIdentity, createGitHubIdentityView } from "./github-identity-view.tsx";
import { SettingsContext, english } from "./i18n.ts";
import { mountPluginContent } from "./render-owned.ts";
import { readSettingsIdentityConfig } from "./settings-config.ts";

export const pluginId = "github-repositories";
function AgentIdentity(props: { context: ControlUiSettingsContextV2; source: SettingsSource }) {
  const context = untrack(() => props.context);
  const deps = createIdentityDependencies(context);
  const identity = createGitHubIdentityView(deps);
  let profileId: string | null = null;
  const sync = () => {
    const snapshot = untrack(() => props.source.read());
    if (snapshot.profile !== undefined) {
      profileId = snapshot.profile?.id ?? null;
    }
    const has = (method: string) => snapshot.advertisedMethods?.includes(method) === true;
    identity.sync({
      client: deps.client,
      connected: snapshot.connected,
      permissionsReady: snapshot.permissionsReady ?? snapshot.connected,
      clientRevision: snapshot.connectionEpoch,
      target: snapshot.agentId
        ? {
            kind: "shared",
            scope: "agent",
            profileId,
            agentId: snapshot.agentId,
            config: readSettingsIdentityConfig(context, snapshot.agentId),
          }
        : null,
      statusReadable: snapshot.canRead === true && has("tools.github.status"),
      configurable: snapshot.canAdmin === true && has("tools.github.configure"),
      authorizable: snapshot.canAdmin === true && has("tools.github.authorize.start"),
    });
    identity.ensureVerified();
  };
  onSettled(() => {
    const stop = props.source.subscribe(sync);
    sync();
    return stop;
  });
  return (
    <GitHubIdentity
      identity={identity}
      onOpenConnections={() =>
        props.context.navigateTo!({ page: "profile", hash: "#settings-profile-github-connections" })
      }
    />
  );
}
function mountSettings(
  container: HTMLElement,
  context: ControlUiSettingsContextV2,
  panel: "connections" | "tools",
) {
  const currentContext = context;
  currentContext.registerEnglish(english);
  let snapshot = context.props;
  const listeners = new Set<() => void>();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const source: SettingsSource = {
    read: () => {
      revision();
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const presentationContext: ControlUiSettingsContextV2 = {
    ...currentContext,
    get props() {
      return source.read();
    },
  };
  const stop = mountPluginContent(
    () => (
      <SettingsContext value={presentationContext}>
        {panel === "connections" ? (
          <GitHubConnections context={presentationContext} source={source} />
        ) : (
          <AgentIdentity context={presentationContext} source={source} />
        )}
      </SettingsContext>
    ),
    container,
  );
  return {
    update(next: ControlUiSettingsSnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
      setRevision((value) => value + 1);
    },
    dispose() {
      listeners.clear();
      stop();
    },
  };
}
export const settingsViews: readonly ControlUiSettingsView[] = [
  {
    placement: {
      id: "connections",
      section: "profile",
      panel: "connections",
      requiredMethods: ["tools.github.status"],
      search: {
        label: "GitHub connections",
        hash: "#settings-profile-github-connections",
        aliases:
          "github oauth account connection publication authentication auth status dashboard actions",
      },
    },
    mount: (container, context) => mountSettings(container, context, "connections"),
  },
  {
    placement: {
      id: "agent-tools",
      section: "agents",
      panel: "tools",
      requiredMethods: ["tools.github.status"],
    },
    mount: (container, context) => mountSettings(container, context, "tools"),
  },
];
