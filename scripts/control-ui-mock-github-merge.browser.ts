/** Demo wiring only. Reuses the existing PR row with simulated merge facts. */
import { noChange, nothing, render } from "lit";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createGitHubPullRequestRenderer } from "../extensions/github/control-ui-api.js";
import type { ControlUiSessionPullRequest } from "../extensions/github/control-ui-contract.js";
import { syncAnchoredOverlay } from "../ui/src/components/anchored-overlay.js";
import { icons } from "../ui/src/components/icons.js";
import { en } from "../ui/src/i18n/locales/en.js";

// Use the existing English copy without the app's Vite-only locale loader.
function t(key: string, params: Record<string, string> = {}): string {
  let value: unknown = en;
  for (const part of key.split(".")) {
    value = value && typeof value === "object" ? Reflect.get(value, part) : undefined;
  }
  if (typeof value !== "string") {
    return key;
  }
  return value.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
}

const renderPullRequests = createGitHubPullRequestRenderer({
  t,
  icons,
  syncDropdownItemRadio: () => {},
  syncChecksOverlay: (details) => syncAnchoredOverlay(details, "top", { alignment: "end" }),
  checksPopupActive: () => noChange,
  renderCi: () => nothing,
});

export default defineControlUiPlugin({
  id: "github",
  activate(host) {
    return host.ui.registerAccessory({
      id: "merge-demo",
      placement: "composer",
      mount(container, initial) {
        let context = initial;
        let elapsed = 0;
        let dismissed = false;
        const preview = new URL(location.href).searchParams.get("merge");
        const pr: ControlUiSessionPullRequest = {
          owner: "openclaw",
          repo: "openclaw",
          number: 163579,
          title: "Support asynchronous PR merges",
          branch: "feat/github-async-merge",
          url: "https://github.com/openclaw/openclaw/pull/163579",
          state: "open",
          additions: 28,
          deletions: 6,
          checks: { state: "passing", passed: 12, failed: 0, skipped: 0, running: 0 },
        };
        const statuses: Record<string, NonNullable<ControlUiSessionPullRequest["merge"]>> = {
          pending: { status: "pending", message: "Waiting for GitHub to finish the merge." },
          verifying: { status: "merged", message: "Confirming the merge completed." },
          queued: { status: "enqueued", message: "Added to the merge queue. Not merged yet." },
          failed: {
            status: "failed",
            message: "Required reviews are missing. Open the PR to resolve.",
          },
          unavailable: {
            status: "unavailable",
            message: "Merge status could not be read. Check the PR on GitHub.",
          },
        };
        function paint() {
          const merged = preview === "merged" || (!preview && elapsed >= 12);
          const mergeStatus = statuses[preview ?? (elapsed >= 8 ? "verifying" : "pending")];
          render(
            dismissed
              ? nothing
              : renderPullRequests({
                  pullRequests: [{ ...pr, state: merged ? "merged" : "open", merge: mergeStatus }],
                  status: "ready",
                  context: null,
                  onDismiss() {
                    dismissed = true;
                    stop();
                    paint();
                  },
                }),
            container,
          );
          if (merged) {
            stop();
          }
        }
        let timer: ReturnType<typeof setInterval> | undefined;
        function stop() {
          clearInterval(timer);
          timer = undefined;
        }
        function reset() {
          stop();
          elapsed = 0;
          dismissed = false;
          paint();
          if (!preview) {
            timer = setInterval(() => {
              if (!context.presented || document.visibilityState === "hidden") {
                return;
              }
              elapsed += 4;
              paint();
            }, 4000);
          }
        }
        context.signal.addEventListener("abort", stop, { once: true });
        reset();
        return {
          update(next) {
            const changed =
              next.props.sessionKey !== context.props.sessionKey ||
              next.props.agentId !== context.props.agentId;
            context = next;
            if (changed) {
              reset();
            }
          },
          dispose() {
            stop();
            render(nothing, container);
          },
        };
      },
    });
  },
});
