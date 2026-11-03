/** @jsxImportSource @solidjs/web */

import "./repository-presentation.css";
import {
  defineControlUiPluginV2,
  type ControlUiViewV2,
  type ControlUiSessionAccessory,
} from "openclaw/plugin-sdk/control-ui";
import { metadataEnglish } from "./metadata-english.ts";
import { publicationEnglish } from "./publication-english.ts";
import {
  createPublicationPresentation,
  createPublicationFactory,
} from "./publication-presentation.ts";
import { createRepositoryBrowserRuntime } from "./repository-runtime.ts";
import { registerOpenPullRequestAction } from "./session-open-pull-request.ts";
import { createSidebarBadgeAccessory } from "./sidebar-accessory.tsx";
import { createGitHubTextReferenceProvider } from "./text-reference-provider.ts";

export { createGitHubIdentity } from "./github-identity.ts";
export type { GitHubIdentity } from "./github-identity.ts";
export { GitHubIdentity as GitHubIdentityView } from "./github-identity-view.tsx";
export { SettingsContext, translator } from "./i18n.ts";
export { GitHubConnectionSetup as GitHubConnectionSetupView } from "./github-identity-view.tsx";
export type { GitHubAuthorizationState } from "./github-identity-shared.ts";
export { GitHubConnections } from "./github-connections.tsx";
export type { SettingsSource } from "./github-connections.tsx";
export { pluginId, settingsViews } from "./settings-views.tsx";
export { english as settingsEnglish } from "./settings-english.ts";

function showError(container: HTMLElement, message: string) {
  const alert = document.createElement("div");
  alert.setAttribute("role", "alert");
  alert.textContent = message;
  container.replaceChildren(alert);
}

function lazyView<T>(load: () => Promise<ControlUiViewV2<T>>): ControlUiViewV2<T> {
  return (container, initial) => {
    let current = initial;
    let mounted: ReturnType<ControlUiViewV2<T>>;
    let disposed = false;
    void load()
      .then((mount) => {
        if (!disposed && !current.signal.aborted) {
          mounted = mount(container, current);
        }
      })
      .catch((error: unknown) => {
        if (!disposed && !current.signal.aborted) {
          showError(
            container,
            current.host.presentation?.formatError(error) ??
              current.host.redact("Repository controls could not load."),
          );
        }
      });
    return {
      update(next) {
        current = next;
        mounted?.update?.(next);
      },
      dispose() {
        disposed = true;
        mounted?.dispose?.();
      },
    };
  };
}

export default defineControlUiPluginV2({
  id: "github-repositories",
  apiVersion: 2,
  activate(host) {
    const runtime = createRepositoryBrowserRuntime(host);
    const publicationFactory = createPublicationFactory(host);
    host.presentation?.registerEnglish(publicationEnglish);
    const stopReferences = host.ui.registerTextReferenceProvider(
      createGitHubTextReferenceProvider(),
    );
    host.presentation?.registerEnglish(metadataEnglish);
    host.presentation?.registerEnglish({ sessionsView: { openPullRequest: "Open PR" } });
    const stopOpenPullRequest = registerOpenPullRequestAction(host, runtime);
    // The active pane owns foreground discovery even while its detail views
    // change or close. Those views share this store, not a second pane cache.
    const stopSessionRead = host.ui.registerAccessory({
      id: "repository-session-read",
      placement: "session-header",
      mount(_container, initial) {
        let context = initial;
        const publication = createPublicationPresentation(
          initial.host,
          () => context,
          () => {},
          publicationFactory,
        );
        const owner = {};
        const sync = () => {
          const key = host.sessions.artifactKey(context.props);
          runtime.store.watch(owner, context.presented && key ? [key] : [], { foreground: true });
          publication.sync();
        };
        const stop = initial.host.subscribe(sync);
        sync();
        return {
          update(next) {
            context = next;
            sync();
          },
          dispose() {
            stop();
            runtime.store.unwatch(owner);
            publication.dispose();
          },
        };
      },
    } satisfies ControlUiSessionAccessory);
    const stopHovercard = host.ui.registerAccessory({
      id: "repository-hovercard",
      placement: "session-hovercard",
      mount: lazyView(() =>
        import("./hovercard-accessory.tsx").then((module) =>
          module.createHovercardAccessoryMount(runtime),
        ),
      ),
    });
    const stopRow = host.ui.registerAccessory(createSidebarBadgeAccessory(host, runtime));
    const stopContext = host.ui.registerAccessory({
      id: "repository",
      placement: "session-context",
      mount: lazyView(() =>
        import("./session-accessory.tsx").then((module) => {
          host.signal.throwIfAborted();
          return module.createSessionAccessoryMount(host, runtime);
        }),
      ),
    });
    const stopEnvironment = host.ui.registerAccessory({
      id: "repository-environment",
      placement: "session-environment",
      mount: lazyView(() =>
        import("./session-accessory.tsx").then((module) => {
          host.signal.throwIfAborted();
          return module.createSessionAccessoryMount(host, runtime, true);
        }),
      ),
    });
    const stopMobile = (["root", "page", "activity"] as const).map((placement) =>
      host.ui.registerAccessory({
        id: `repository-mobile-${placement}`,
        placement: `session-mobile-${placement}`,
        mount: lazyView(() =>
          import("./session-accessory.tsx").then((module) => {
            host.signal.throwIfAborted();
            return module.createMobileSessionAccessoryMount(host, runtime, placement);
          }),
        ),
      }),
    );
    const stopActivity = host.ui.registerAccessory({
      id: "repository-activity",
      placement: "session-activity",
      mount: lazyView(() =>
        import("./activity-accessory.tsx").then((module) =>
          module.createActivityAccessoryMount(runtime),
        ),
      ),
    });
    const stopSummary = host.ui.registerAccessory({
      id: "repository-summary",
      placement: "session-summary",
      mount: lazyView(() =>
        import("./summary-accessory.tsx").then((module) =>
          module.createSummaryAccessoryMount(runtime),
        ),
      ),
    });
    return () => {
      // Retire the shared read owner before contribution cleanup releases its watches.
      runtime.store.dispose();
      stopMobile.forEach((stop) => stop());
      stopSessionRead();
      stopOpenPullRequest();
      stopHovercard();
      stopRow();
      stopContext();
      stopEnvironment();
      stopActivity();
      stopSummary();
      stopReferences();
    };
  },
});
