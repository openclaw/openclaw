/** @jsxImportSource @solidjs/web */
import type { ControlUiSessionAccessory } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import { ActivityRead } from "./activity-read.tsx";
import { NativeContext } from "./native-context.tsx";
import { PresentationContext } from "./presentation-context.ts";
import { mountPluginContent } from "./render-owned.ts";
import type { RepositoryBrowserRuntime } from "./repository-runtime.ts";
import { orderSessionPullRequests } from "./session-pull-request-presentation.ts";

export function createActivityAccessoryMount(
  runtime: RepositoryBrowserRuntime,
): ControlUiSessionAccessory["mount"] {
  return (container, initial) => {
    let context = initial;
    const { native, presentation } = initial.host;
    if (!native || !presentation) {
      throw new Error("Repository presentation services are unavailable.");
    }
    presentation.registerEnglish({
      activity: {
        git: {
          pullRequest: "{repository} pull request #{number}: {title} ({state})",
          branchDiff: "{branch}: changes against the default branch, including uncommitted work",
          stale: "Git status may be out of date",
          open: "Open",
          draft: "Draft",
          merged: "Merged",
          closed: "Closed",
        },
      },
    });
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const changed = () => {
      if (!context.signal.aborted) {
        setRevision((value) => value + 1);
      }
    };
    const owner = {};
    let key = "";
    const sync = () => {
      if (context.signal.aborted) {
        return;
      }
      if (context.signal.aborted) {
        return;
      }
      key = initial.host.sessions.artifactKey(context.props);
      runtime.store.watch(owner, context.presented && key ? [key] : [], { foreground: true });
      changed();
    };
    const stops = [
      initial.host.subscribe(sync),
      runtime.store.subscribe(changed),
      presentation.subscribe(changed),
    ];
    const snapshot = () => {
      revision();
      return runtime.store.get(key);
    };
    const branch = () =>
      snapshot()?.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft")
        ? undefined
        : snapshot()?.branch;
    const pullRequests = () => orderSessionPullRequests(snapshot()?.pullRequests ?? []);
    const stop = mountPluginContent(
      () => (
        <PresentationContext value={presentation}>
          <NativeContext value={native}>
            <Show when={branch() || pullRequests().length}>
              <ActivityRead
                sessionKey={(revision(), context.props.sessionKey)}
                agentId={(revision(), context.props.agentId)}
                branch={branch()}
                pullRequests={pullRequests()}
                stale={snapshot()?.status !== "ready" || !context.host.connection.connected}
              />
            </Show>
          </NativeContext>
        </PresentationContext>
      ),
      container,
    );
    sync();
    return {
      update(next) {
        context = next;
        sync();
      },
      dispose() {
        stops.forEach((unsubscribe) => unsubscribe());
        runtime.store.unwatch(owner);
        stop();
      },
    };
  };
}
