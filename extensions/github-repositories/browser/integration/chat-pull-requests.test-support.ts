import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "@openclaw/gateway-protocol";
import { createComponent, createSignal, flush, merge } from "solid-js";
import type { ApplicationGateway } from "../../../../ui/src/app/gateway.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/mount-solid.ts";
import type { ChatPullRequestsProps } from "../chat-pull-request-shared.tsx";
import { ChatPullRequestsContent } from "../chat-pull-requests-content.tsx";
import type { GitHubPublicationView } from "../github-publication-owner.ts";
import { RepositoryPresentation } from "./repository-ci.test-support.tsx";

function fixture<T>(create: () => T) {
  return (overrides: Partial<T> = {}): T => ({ ...create(), ...overrides });
}

export const pullRequest = fixture<ControlUiSessionPullRequest>(() => ({
  number: 103469,
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
  title: "fix(macos): tighten the link-browser tab header",
  url: "https://github.com/openclaw/openclaw/pull/103469",
  state: "open",
  additions: 4,
  deletions: 3,
  checks: { state: "passing", passed: 5, failed: 0, skipped: 1, running: 0 },
  checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
}));

export const publication = fixture<GitHubPublicationView>(() => ({
  readiness: { read: null, retired: new Promise(() => {}) },
  activity: null,
  canPublishShared: true,
  canPublishPersonal: true,
  locked: false,
  options: null,
  selection: {
    source: "shared",
    expected: { source: "system-configured", accountId: 1, login: "system-bot" },
  },
  result: null,
  confirmation: null,
  error: null,
  optionsUnavailable: false,
  personalReady: true,
  onPublish: () => {},
  onRefresh: () => {},
}));

export const sessionBranch = fixture<ControlUiSessionBranch>(() => ({
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/cloud-workers-live-events",
  additions: 2819,
  deletions: 205,
  createUrl: "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
}));

export type TestChatPullRequestsProps = ChatPullRequestsProps & { gateway?: ApplicationGateway };

const views = new WeakMap<
  HTMLElement,
  { update: (props: TestChatPullRequestsProps) => void; unmount: () => void }
>();

export function paintChatPullRequests(
  overrides: Partial<TestChatPullRequestsProps>,
  container: HTMLElement,
) {
  const props: TestChatPullRequestsProps = {
    pullRequests: [],
    status: "ready",
    onDismiss() {},
    ...overrides,
  };
  const view = views.get(container);
  if (view) {
    view.update(props);
  } else {
    let update!: (props: TestChatPullRequestsProps) => void;
    const mounted = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(props);
        let currentInput = props;
        update = (next) => {
          currentInput = next;
          setCurrent(next);
        };
        return createComponent(RepositoryPresentation, {
          get gateway() {
            return current().gateway;
          },
          live: () => ({
            sessionKey: currentInput.sessionKey ?? "",
            sessionId: currentInput.sessionId,
            presented:
              typeof currentInput.presented === "object"
                ? currentInput.presented.isPresented()
                : (currentInput.presented ?? true),
            pullRequest: currentInput.pullRequests[0],
          }),
          get children() {
            return createComponent(ChatPullRequestsContent, merge(current));
          },
        });
      },
      { container },
    );
    views.set(container, { update, unmount: mounted.unmount });
  }
  flush();
}

export function clearChatPullRequests(container: HTMLElement) {
  views.get(container)?.unmount();
  views.delete(container);
}
