/** @jsxImportSource @solidjs/web */
import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import "../../../../ui/src/pages/chat/chat-details-mobile-host-content.tsx";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../../ui/src/api/types.ts";
import {
  createChatMobileHostFixture,
  createMobileRootContentFixture as rootContent,
} from "../../../../ui/src/pages/chat/chat-mobile-host.test-support.ts";
import type {
  ChatMobileHost,
  MobileHostDestination,
} from "../../../../ui/src/pages/chat/chat-mobile-host.ts";
import {
  ChatDetailsMobileContent,
  type ChatDetailsMobilePage,
} from "../../../../ui/src/pages/chat/components/chat-details-mobile-content.tsx";
import type { ChatDetailsProps } from "../../../../ui/src/pages/chat/components/chat-details-types.ts";
import {
  createGateway,
  createContext,
  createSessions,
} from "../../../../ui/src/test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../../../ui/src/test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../../../ui/src/test-helpers/gateway-client.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/mount-solid.ts";
import { installRepositoryPresentation } from "../../../../ui/src/test-helpers/repository-presentation.test-support.ts";
import { waitForSolid } from "../../../../ui/src/test-helpers/solid-settle.ts";
import { listDismissedChatPullRequests, chatBranchId } from "../api.ts";
import { options as publicationOptions } from "./chat-github-publication.test-support.ts";
import { pullRequest, sessionBranch } from "./chat-pull-requests.test-support.ts";

function details(overrides: Partial<ChatDetailsProps> = {}): ChatDetailsProps {
  return {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", kind: "direct" },
    ...overrides,
  };
}

async function settle(element: HTMLElementTagNameMap["openclaw-chat-details-mobile-host-content"]) {
  await element.updateComplete;
  flush();
}

async function mountMobileHost(
  value: ChatDetailsProps,
  snapshot?: ControlUiSessionPullRequestSnapshot | (() => ControlUiSessionPullRequestSnapshot),
) {
  const navigate = vi.fn<(destination: MobileHostDestination) => void>();
  const host: ChatMobileHost = createChatMobileHostFixture("mobile-pr-session", {
    open: true,
    height: 280,
    reservedHeight: 280,
    destination: { area: "details" },
    navigate,
  });
  const element = document.createElement("openclaw-chat-details-mobile-host-content");
  element.details = value;
  element.host = host;
  element.presented = true;
  element.bindings = {
    goal: { connected: false, canAct: false },
  };
  const gateway = createGateway(
    createTestGatewayClient(async (method) =>
      method === "sessions.github.options" ? publicationOptions : {},
    ),
  );
  gateway.snapshot.hello!.features!.methods!.push(
    "sessions.github.options",
    "sessions.github.publish",
  );
  const source = createContext(gateway, createSessions("main", [value.sessionKey]));
  if (value.selectedSession) {
    source.sessions.reconcile(value.selectedSession);
  }
  const activation = snapshot
    ? installRepositoryPresentation(
        source,
        typeof snapshot === "function" ? snapshot : () => snapshot,
      )
    : undefined;
  const provider = activation ? createApplicationContextProvider(activation.context) : undefined;
  provider?.append(element);
  const view = mountSolid(() => provider ?? element);
  await element.updateComplete;
  flush();
  const show = async (destination: MobileHostDestination) => {
    element.host = { ...element.host!, destination };
    await element.updateComplete;
    flush();
  };
  return {
    view,
    element,
    navigate,
    show,
    activation,
    back: host.back,
    query: (selector: string) => view.container.querySelector<HTMLElement>(selector),
    button: (name: string) => view.getByRole("button", { name }),
  };
}

it("retains Outputs demand across publications and returns navigation origins without a second route owner", () => {
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const output = {
    artifacts: [],
    artifactsError: null,
    dashboard: null,
    dashboardError: null,
    onOpenArtifact: vi.fn(),
    renderArtifactIcon: () => null,
    onViewAll: vi.fn(),
    renderViewAllIcon: () => null,
  };
  const [value, setValue] = createSignal(details({ outputs: output, retainOutputs: retain }));
  const [presented, setPresented] = createSignal(true);
  const content = rootContent();
  const [page, setPage] = createSignal<ChatDetailsMobilePage>({ kind: "root", content });
  const view = mountSolid(() => (
    <ChatDetailsMobileContent details={value()} presented={presented()} page={page()} />
  ));
  expect(retain).toHaveBeenCalledOnce();
  const people = view.getByRole("button", { name: "People" });
  people.click();
  expect(content.entries.onNavigate).toHaveBeenCalledWith(
    { kind: "people" },
    { kind: "details-root", trigger: people },
  );
  view.getByRole("button", { name: /Versions/ }).click();
  expect(content.entries.onNavigate).toHaveBeenLastCalledWith(
    { kind: "versions" },
    expect.objectContaining({ kind: "details-root" }),
  );
  const updated = details({ outputs: { ...output, artifacts: null }, retainOutputs: retain });
  setValue(updated);
  flush();
  expect(retain).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  setPage({ kind: "outputs" });
  flush();
  expect(retain).toHaveBeenCalledOnce();
  setPage({
    kind: "task-progress",
    content: { showTaskProgress: true, onShowTaskProgressChange: vi.fn() },
  });
  flush();
  expect(release).toHaveBeenCalledOnce();
  setPage({ kind: "root", content });
  flush();
  expect(retain).toHaveBeenCalledTimes(2);
  setPresented(false);
  flush();
  expect(release).toHaveBeenCalledTimes(2);
  const hiddenPeople = view.getByRole("button", { name: "People" });
  expect(hiddenPeople.hasAttribute("disabled")).toBe(true);
  hiddenPeople.click();
  expect(content.entries.onNavigate).toHaveBeenCalledTimes(2);
  setPresented(true);
  flush();
  expect(retain).toHaveBeenCalledTimes(3);
  expect(view.getByRole("button", { name: "People" })).toBe(hiddenPeople);
  const releaseReplacement = vi.fn();
  const retainReplacement = vi.fn(() => releaseReplacement);
  setValue({ ...updated, retainOutputs: retainReplacement });
  flush();
  expect(release).toHaveBeenCalledTimes(3);
  expect(retainReplacement).toHaveBeenCalledOnce();
  expect(view.getByRole("button", { name: "People" })).toBe(hiddenPeople);
  view.unmount();
  expect(release).toHaveBeenCalledTimes(3);
  expect(releaseReplacement).toHaveBeenCalledOnce();
});

it("replaces the People activation owner while retaining the mobile host content", async () => {
  const { view, element, show, query } = await mountMobileHost(details());
  const release = vi.fn();
  const activate = vi.fn(() => release);
  const releaseReplacement = vi.fn();
  const activateReplacement = vi.fn(() => releaseReplacement);
  const mentions = {
    status: "idle" as const,
    error: undefined,
    truncated: false,
    read: () => null,
    request: async () => {},
    insert: () => false,
    activate,
  };
  try {
    const root = query(".chat-details-mobile-root");
    element.bindings = { ...element.bindings!, peopleMentions: mentions };
    await element.updateComplete;
    expect(activate).not.toHaveBeenCalled();
    await show({
      area: "details",
      page: { key: "people", title: "People", details: { kind: "people" } },
    });
    expect(activate).toHaveBeenCalledOnce();
    for (const status of ["loading", "ready"] as const) {
      element.bindings = { ...element.bindings!, peopleMentions: { ...mentions, status } };
      await settle(element);
      expect(activate).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(query(".chat-details-mobile-root")).toBe(root);
    }
    element.bindings = {
      ...element.bindings!,
      peopleMentions: { ...mentions, activate: activateReplacement },
    };
    await settle(element);
    expect(release).toHaveBeenCalledOnce();
    expect(activateReplacement).toHaveBeenCalledOnce();
    expect(query(".chat-details-mobile-root")).toBe(root);
    await show({ area: "details" });
    expect(releaseReplacement).toHaveBeenCalledOnce();
    expect(query(".chat-details-mobile-root")).toBe(root);
  } finally {
    view.unmount();
  }
  expect(release).toHaveBeenCalledOnce();
  expect(releaseReplacement).toHaveBeenCalledOnce();
});

it("routes plugin-owned mobile PR details through the native Root and Back history", async () => {
  const request = pullRequest({
    title: "Current PR",
    headSha: "a".repeat(40),
    additions: 1234,
    deletions: 2000,
  });
  const { view, element, navigate, show } = await mountMobileHost(details(), {
    pullRequests: [request],
    rateLimited: false,
    status: "ready",
  });
  try {
    await waitForSolid(() =>
      expect(
        view.container.querySelector('[data-details-page="root"] .chat-pr-mobile__row'),
      ).not.toBeNull(),
    );
    const row = view.container.querySelector<HTMLButtonElement>(
      '[data-details-page="root"] .chat-pr-mobile__row',
    )!;
    expect(row.querySelector(".chat-pr__additions")?.textContent).toBe("+1,234");
    expect(row.querySelector(".chat-pr__deletions")?.textContent).toBe("−2,000");
    expect(row.querySelector(".chat-pr-mobile__row-meta")?.textContent).toContain("+1,234 −2,000");
    row.click();
    expect(navigate).toHaveBeenCalledOnce();
    const destination = navigate.mock.calls[0]![0];
    expect(destination.page?.details).toEqual({
      kind: "contribution",
      pluginId: "github-repositories",
      id: "pull-request:openclaw/openclaw#103469",
    });
    expect(destination.backTo).toEqual({ area: "details" });
    await show(destination);
    await waitForSolid(() => expect(view.queryByRole("button", { name: "Checks" })).not.toBeNull());
    expect(view.container.querySelector(".chat-pr-mobile__diff")?.textContent).toContain(
      "+1,234−2,000",
    );
    row.click();
    expect(navigate).toHaveBeenCalledOnce();
    view.getByRole("button", { name: "Checks" }).click();
    expect(navigate).toHaveBeenCalledTimes(2);
    const checks = navigate.mock.calls[1]![0];
    expect(checks.page?.details).toEqual({
      kind: "contribution",
      pluginId: "github-repositories",
      id: "checks:openclaw/openclaw#103469",
    });
    expect(checks.backTo).toBe(destination);
    await show(checks);
    await waitForSolid(() =>
      expect(view.container.querySelector("openclaw-chat-ci-details")).not.toBeNull(),
    );
    await show(destination);
    const stale = view.getByRole("button", { name: "Checks" });
    element.details = details();
    stale.click();
    expect(navigate).toHaveBeenCalledTimes(2);
    await element.updateComplete;
    flush();
    const previousHost = view.getByRole("button", { name: "Checks" });
    element.host = { ...element.host!, scopeKey: "replacement-session" };
    previousHost.click();
    expect(navigate).toHaveBeenCalledTimes(2);
    await element.updateComplete;
    flush();
    const staleSession = view.getByRole("button", { name: "Checks" });
    element.details = details({ sessionKey: "agent:main:replacement" });
    staleSession.click();
    expect(navigate).toHaveBeenCalledTimes(2);
    await element.updateComplete;
    flush();
  } finally {
    view.unmount();
  }
});

it("dismisses only the current mobile branch after explicit activation", async () => {
  localStorage.removeItem("openclaw.chat.dismissedPullRequests");
  const branch = sessionBranch({ branch: "feature/current" });
  const replacement = sessionBranch({ branch: "feature/replacement" });
  let snapshot: ControlUiSessionPullRequestSnapshot = {
    pullRequests: [],
    branch,
    rateLimited: false,
    status: "ready",
  };
  const row: GatewaySessionRow = {
    key: "agent:main:details",
    sessionId: "mobile-branch",
    kind: "direct",
    worktree: { id: "mobile-worktree", branch: branch.branch, repoRoot: "/synthetic/repository" },
  };
  const value = details({
    selectedSession: row,
    sessionHeaderFacts: {
      session: row,
      participationBlocked: false,
      hasActiveRun: false,
      workspaceReady: true,
      workspaceConflict: false,
    },
  });
  const { view, element, navigate, show, activation } = await mountMobileHost(
    value,
    () => snapshot,
  );
  const dismissed = () => listDismissedChatPullRequests(localStorage, value.sessionKey);
  try {
    await waitForSolid(() =>
      expect(
        view.container.querySelector('[data-details-destination="publication"]'),
        "The current branch must appear in the native Root publication entry",
      ).not.toBeNull(),
    );
    view.container
      .querySelector<HTMLButtonElement>('[data-details-destination="publication"]')!
      .click();
    expect(navigate).toHaveBeenCalledOnce();
    const destination = navigate.mock.calls[0]![0];
    await show(destination);
    await waitForSolid(() =>
      expect(
        view.queryByRole("button", { name: "Hide feature/current for this session" }),
        "The native publication destination must expose the current branch",
      ).not.toBeNull(),
    );
    const stale = view.getByRole("button", { name: "Hide feature/current for this session" });
    expect(dismissed().size).toBe(0);
    // The real accessory must consult its store before Solid publishes replacement branch inputs.
    snapshot = { ...snapshot, branch: replacement };
    activation!.notify();
    stale.click();
    expect(dismissed().size).toBe(0);
    flush();
    const previousHost = view.getByRole("button", {
      name: "Hide feature/replacement for this session",
    });
    element.host = { ...element.host! };
    previousHost.click();
    expect(dismissed().size).toBe(0);
    await element.updateComplete;
    await waitForSolid(() => {
      const slots = [
        ...view.container.querySelectorAll<HTMLElementTagNameMap["openclaw-plugin-view"]>(
          "openclaw-plugin-view",
        ),
      ];
      expect(
        slots.some((slot) => {
          const props = slot.props as {
            detailsPage?: string;
            facts?: { readCurrent?: () => unknown };
          };
          return props.detailsPage === "publication" && Boolean(props.facts?.readCurrent?.());
        }),
      ).toBe(true);
    });
    await waitForSolid(() =>
      expect(
        view
          .getByRole("button", { name: "Hide feature/replacement for this session" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    view.getByRole("button", { name: "Hide feature/replacement for this session" }).click();
    expect([...dismissed()]).toEqual([chatBranchId(replacement)]);
    await show(destination.backTo!);
    await waitForSolid(() =>
      expect(view.container.querySelector('[data-details-destination="publication"]')).toBeNull(),
    );
  } finally {
    view.unmount();
    localStorage.removeItem("openclaw.chat.dismissedPullRequests");
  }
});
