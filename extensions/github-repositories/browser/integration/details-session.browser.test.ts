import type { ControlUiSessionPullRequestSnapshot } from "@openclaw/gateway-protocol";
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ChatDetailsSession } from "../../../../ui/src/pages/chat/components/chat-details-session.tsx";
import type { ChatDetailsProps } from "../../../../ui/src/pages/chat/components/chat-details-types.ts";
import { disposeSidebarContextLifecycles } from "../../../../ui/src/test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../../../../ui/src/test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../../ui/src/test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../../ui/src/test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../../ui/src/test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/mount-solid.ts";
import { installRepositoryPresentation } from "../../../../ui/src/test-helpers/repository-presentation.test-support.ts";
import { createSolidApplicationContextProvider } from "../../../../ui/src/test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../../ui/src/test-helpers/solid-settle.ts";
import { dismissChatPullRequest, chatBranchId } from "../api.ts";
import baseStyles from "../../../../ui/src/styles/base.css?inline";

const repositoryFixtures = new WeakMap<
  ChatDetailsSession,
  {
    publish: (snapshot: ControlUiSessionPullRequestSnapshot | undefined) => void;
    request: ReturnType<typeof createGatewayRequestMock>;
  }
>();

async function mount(
  overrides: Partial<ChatDetailsProps> = {},
  initialSnapshot?: ControlUiSessionPullRequestSnapshot,
  readMethods: readonly string[] = [],
) {
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = baseStyles;
  onTestFinished(() => style.remove());
  let snapshot = initialSnapshot;
  const request = createGatewayRequestMock(async (method) => {
    if (method === "cron.list") {
      return {
        jobs: [],
        total: 0,
        offset: 0,
        limit: 200,
        hasMore: false,
        nextOffset: null,
        snapshotRevision: "1",
      };
    }
    if (method === "cron.status") {
      return { enabled: true, triggersEnabled: true, jobs: 0 };
    }
    throw new Error(`Unexpected Details repository request: ${method}`);
  });
  const value: ChatDetailsProps = {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", kind: "direct" },
    ...overrides,
  };
  const fallback = createApplicationGateway();
  fallback.publish({
    ...fallback.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
    hello: gatewayHelloForMethods(readMethods),
    assistantAgentId: "main",
    sessionKey: value.sessionKey,
  });
  const gateway = value.gateway ?? fallback.gateway;
  const context = createContext(gateway, createSessions("main", [value.sessionKey]));
  onTestFinished(disposeSidebarContextLifecycles);
  if (value.selectedSession) {
    context.sessions.reconcile(value.selectedSession);
  }
  const activation = installRepositoryPresentation(context, () => snapshot);
  const view = mountSolid(
    () => createComponent(ChatDetailsSession, { props: value, presented: true }),
    { wrapper: createSolidApplicationContextProvider(activation.context).wrapper },
  );
  const element = view.container.querySelector("openclaw-chat-details-session")!;
  repositoryFixtures.set(element, {
    request,
    publish(next) {
      snapshot = next;
      activation.notify();
      flush();
    },
  });
  await element.updateComplete;
  return element;
}

async function publishRepositorySnapshot(
  element: ChatDetailsSession,
  snapshot: ControlUiSessionPullRequestSnapshot | undefined,
) {
  repositoryFixtures.get(element)!.publish(snapshot);
  await element.updateComplete;
}

it("omits empty linked-work disclosures and opens arriving pull requests", async () => {
  const element = await mount();
  // Retained plugin content may stay mounted, but empty native groups are not presented.
  const linkedWork = () =>
    [
      ...element.querySelectorAll(
        '[data-details-group="pull-requests"], [data-details-group="automations"], [data-details-group="subagents"], [data-details-group="processes"]',
      ),
    ].find((group) => !group.closest("[hidden]")) ?? null;
  expect(linkedWork()).toBeNull();
  const pullRequests: ControlUiSessionPullRequestSnapshot["pullRequests"] = [
    {
      number: 7,
      owner: "example",
      repo: "project",
      branch: "feature",
      title: "A pull request arriving after the panel opens",
      url: "https://github.com/example/project/pull/7",
      state: "open",
    },
  ];
  await publishRepositorySnapshot(element, { pullRequests, status: "ready", rateLimited: false });
  await waitForSolid(() => expect(element.querySelector(".chat-pr__link")).not.toBeNull());
  const group = element.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')!;
  expect(group.open).toBe(true);
  group.querySelector("summary")!.click();
  flush();
  element.props = { ...element.props! };
  await element.updateComplete;
  expect(group.open).toBe(false);
  await publishRepositorySnapshot(element, undefined);
  expect(linkedWork()).toBeNull();
  expect(element.querySelector(".chat-details-session > summary")).toBeNull();
  await publishRepositorySnapshot(element, { pullRequests, status: "ready", rateLimited: false });
  await waitForSolid(() =>
    expect(
      element.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')?.open,
    ).toBe(true),
  );
});

it("uses the current PR renderer and preserves CI session identity and branch dismissal", async () => {
  const session = {
    key: "agent:main:details",
    kind: "direct" as const,
    sessionId: "incarnation-7",
  };
  const element = await mount(
    {
      selectedSession: session,
      sessionHeaderFacts: {
        session,
        participationBlocked: false,
        hasActiveRun: false,
        workspaceReady: true,
        workspaceConflict: false,
      },
    },
    {
      pullRequests: [
        {
          number: 7,
          owner: "example",
          repo: "project",
          branch: "feature",
          title: "A compact PR title",
          url: "https://github.com/example/project/pull/7",
          state: "open",
          additions: 84,
          deletions: 41,
        },
      ],
      status: "ready",
      rateLimited: false,
    },
    ["cron.list", "cron.status"],
  );
  await waitForSolid(() =>
    expect(element.querySelector(".chat-pr__title")?.textContent).toBe("A compact PR title"),
  );
  const link = element.querySelector(".chat-pr__link")!;
  expect(link.getAttribute("href")).toBe("https://github.com/example/project/pull/7");
  expect(element.querySelector("openclaw-chat-ci-automation")).toBeNull();
  const request = repositoryFixtures.get(element)!.request;
  // The actual CI owner stays cold until its monitoring page is opened.
  expect(request).not.toHaveBeenCalledWith("cron.list", expect.anything(), expect.anything());
  element.querySelector<HTMLButtonElement>(".chat-pr__actions button")!.click();
  flush();
  const menu = element.querySelector(".chat-pr__actions")!;
  for (const fact of ["example/project", "#7", "Open", "+84", "−41"]) {
    expect(menu.textContent).toContain(fact);
  }
  await waitForSolid(() =>
    expect(menu.querySelector("button")?.getAttribute("aria-expanded")).toBe("true"),
  );
  menu.querySelector<HTMLButtonElement>('[data-value="monitoring"]')!.click();
  flush();
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(element.querySelector("openclaw-chat-ci-automation")).not.toBeNull(),
  );
  const automation = element.querySelector("openclaw-chat-ci-automation");
  expect(automation?.closest<HTMLElement>(".chat-pr-menu__page")?.hidden).toBe(false);
  // Admission requires the Details facts and CI target to share incarnation-7.
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ sessionKey: session.key, sessionAgentId: "main" }),
      expect.any(Object),
    ),
  );
  // A successfully admitted inventory must settle into usable monitoring controls.
  await waitForSolid(() =>
    expect(automation?.querySelector<HTMLInputElement>("input")?.disabled).toBe(false),
  );
  const branch = {
    owner: "example",
    repo: "project",
    branch: "feature",
    createUrl: "https://github.com/example/project/compare/feature",
  };
  dismissChatPullRequest(window.localStorage, session.key, chatBranchId(branch));
  await publishRepositorySnapshot(element, {
    pullRequests: [],
    branch,
    status: "ready",
    rateLimited: false,
  });
  expect(element.querySelector(".chat-pr")).toBeNull();
});
