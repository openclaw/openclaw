/** @jsxImportSource @solidjs/web */
import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PRESENTATION_CHANGED_EVENT } from "../../../../ui/src/lib/presentation.ts";
import { ContentPresentation } from "../../../../ui/src/lib/solid/presentation.ts";
import { ChatDetailsDesktopBody } from "../../../../ui/src/pages/chat/components/chat-details-desktop-body.tsx";
import { ChatDetailsSession } from "../../../../ui/src/pages/chat/components/chat-details-session.tsx";
import { disposeSidebarContextLifecycles } from "../../../../ui/src/test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessions } from "../../../../ui/src/test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../../ui/src/test-helpers/application-context-fixtures.ts";
import {
  createTestGatewayClient,
  createGatewayRequestMock,
} from "../../../../ui/src/test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../../ui/src/test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/mount-solid.ts";
import { installRepositoryPresentation } from "../../../../ui/src/test-helpers/repository-presentation.test-support.ts";
import { createSolidApplicationContextProvider } from "../../../../ui/src/test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../../ui/src/test-helpers/solid-settle.ts";
import { ChatPullRequests } from "../api.ts";
import "../repository-chat.css";
import "../repository-presentation.css";
import { RepositoryEnvironment } from "../repository-environment.tsx";
import { publication, sessionBranch } from "./chat-pull-requests.test-support.ts";
import { mountRepositorySolid } from "./repository-ci.test-support.tsx";
import environmentStyles from "../../../../ui/src/pages/chat/components/chat-details-environment-desktop.css?inline";
import baseStyles from "../../../../ui/src/styles/base.css?inline";
import desktopDetailsStyles from "../../../../ui/src/styles/chat/details-desktop.css?inline";
import detailsStyles from "../../../../ui/src/styles/chat/details.css?inline";
import layoutStyles from "../../../../ui/src/styles/chat/layout.css?inline";
import componentsStyles from "../../../../ui/src/styles/components.css?inline";

const container = document.createElement("div");
let mounted: ReturnType<typeof mountSolid> | undefined;
let originalViewport: { width: number; height: number };
beforeEach(() => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  mounted?.unmount();
  mounted = undefined;
  container.remove();
  disposeSidebarContextLifecycles();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each(["props", "owner", "parked"])(
  "hides a retained pane's CI popup and restores disclosure through %s presentation",
  async (mode) => {
    await page.viewport(800, 600);
    document.body.append(container);
    const owner = new EventTarget();
    let isPresented = true;
    let updatePresented!: (value: boolean) => void;
    let updateParked!: (value: boolean) => void;
    let updateDismissed!: (value: boolean) => void;
    const binding = { owner, isPresented: () => isPresented };
    mounted = mountRepositorySolid(
      () => {
        const [presented, setPresented] = createSignal(true);
        const [active, setActive] = createSignal(true);
        const [dismissed, setDismissed] = createSignal(false);
        updatePresented = setPresented;
        updateParked = setActive;
        updateDismissed = setDismissed;
        return (
          <ContentPresentation value={active}>
            <style>
              {baseStyles}
              {layoutStyles}
            </style>
            <section
              style={{
                width: "500px",
                "padding-top": "260px",
                opacity: mode === "props" && !presented() ? 0 : 1,
              }}
            >
              <ChatPullRequests
                pullRequests={[
                  {
                    number: 42,
                    owner: "example",
                    repo: "release-planning",
                    branch: "review",
                    title: "Review release checklist",
                    url: "https://github.com/example/release-planning/pull/42",
                    state: "open",
                    checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
                  },
                ]}
                status="ready"
                presented={mode === "props" ? presented() : binding}
                dismissed={dismissed()}
                onDismiss={() => {}}
              />
            </section>
          </ContentPresentation>
        );
      },
      { container },
    );
    const draw = (presented: boolean, dismissed = false) => {
      updateDismissed(dismissed);
      isPresented = presented;
      if (mode === "props") {
        updatePresented(presented);
      } else {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        if (mode === "parked") {
          updateParked(presented);
        }
      }
      flush();
    };
    draw(true);
    await waitForSolid(() => expect(container.querySelector(".chat-pr__checks")).not.toBeNull());
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    const summary = disclosure.querySelector("summary")!;
    const menu = page.elementLocator(
      container.querySelector<HTMLElement>(".chat-pr__checks-menu")!,
    );
    await page.elementLocator(summary).click();
    await expect.element(menu).toBeVisible();

    draw(false);
    await expect.element(menu).not.toBeVisible();
    expect(disclosure.open).toBe(true);

    draw(true);
    await expect.element(menu).toBeVisible();
    expect(container.querySelector(".chat-pr__checks")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    summary.focus();
    await userEvent.keyboard(" ");
    await expect.element(menu).not.toBeVisible();
    if (mode === "props") {
      await page.elementLocator(summary).click();
      await expect.element(menu).toBeVisible();
      draw(false, true);
      await expect.element(menu).not.toBeVisible();
      expect(disclosure.open).toBe(false);
      draw(true);
      await expect.element(menu).not.toBeVisible();
      expect(disclosure.open).toBe(false);
    }
  },
);

it.each([
  { viewport: 1440, width: 360, repo: "openclaw", clipped: false },
  {
    viewport: 900,
    width: 300,
    repo: "a-very-long-repository-name-that-needs-truncation",
    clipped: false,
  },
  { viewport: 393, width: 360, repo: "openclaw", clipped: false },
  { viewport: 900, width: 300, repo: "openclaw", clipped: true },
])(
  "keeps the contributed branch row above aligned diff and publication actions at $viewport/$width (clipped: $clipped)",
  async ({ viewport, width, repo, clipped }) => {
    await page.viewport(viewport, 700);
    document.body.append(container);
    const onPublish = vi.fn();
    const onSelect = vi.fn();
    const onDismissBranch = vi.fn();
    const branch = sessionBranch({
      repo,
      branch: clipped
        ? "openclaw/custom-snooze-date-time-with-a-branch-name-that-needs-truncation"
        : "openclaw/custom-snooze-date-time",
    });
    const shared = { source: "agent-override" as const, accountId: 1, login: "agent-bot" };
    mounted = mountRepositorySolid(
      () => (
        <>
          <style>{`${baseStyles}${componentsStyles}${layoutStyles}${detailsStyles}${desktopDetailsStyles}${environmentStyles}`}</style>
          <section
            class="chat-details"
            data-desktop
            data-open
            data-instant
            style={{ position: "relative", width: `${width}px`, "max-width": "none" }}
          >
            <ChatDetailsDesktopBody presented>
              <RepositoryEnvironment
                worktree={false}
                presented
                {...{
                  pullRequests: [],
                  branch,
                  status: "ready",
                  onDismiss: () => {},
                  onDismissBranch,
                  publication: publication({
                    onPublish,
                    onSelect,
                    options: {
                      shared,
                      personal: {
                        state: "connected",
                        generation: "personal",
                        account: { accountId: 2, login: "alice-tools" },
                        accessExpiresAtMs: null,
                        refreshState: "available",
                        pending: null,
                      },
                      pendingPersonal: null,
                      latestShared: null,
                    },
                    selection: { source: "shared", expected: shared },
                  }),
                }}
              />
            </ChatDetailsDesktopBody>
          </section>
        </>
      ),
      { container },
    );
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(
        container.querySelector(".chat-environment__branch .chat-pr__actions-trigger"),
      ).not.toBeNull(),
    );
    const row = container.querySelector<HTMLElement>(".chat-environment__branch")!;
    const branchLabel = row.querySelector<HTMLElement>(".chat-environment__branch-name")!;
    const diff = row.querySelector<HTMLElement>(".chat-pr__diff")!;
    const trigger = row.querySelector<HTMLButtonElement>(".chat-pr__actions-trigger")!;
    const publish = page.getByRole("button", { name: "Create PR", exact: true });
    await expect.element(publish).toBeVisible();
    const publishButton = row.querySelector<HTMLButtonElement>("button.chat-pr__create")!;
    await expect.element(page.elementLocator(row)).toBeVisible();
    await expect.element(page.elementLocator(trigger)).toBeVisible();
    expect(publishButton.getBoundingClientRect().height).toBe(26);
    expect(trigger.getBoundingClientRect().width).toBeGreaterThanOrEqual(26);
    expect(row.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(viewport);
    expect(branchLabel.textContent).toBe(branch.branch);
    expect(row.querySelector(".chat-pr__repo")).toBeNull();
    expect(
      Math.abs(branchLabel.getBoundingClientRect().left - diff.getBoundingClientRect().left),
    ).toBeLessThanOrEqual(1);
    expect(diff.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      branchLabel.getBoundingClientRect().bottom,
    );
    expect(
      diff.getBoundingClientRect().top - branchLabel.getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(12);
    expect(diff.getBoundingClientRect().right).toBeLessThanOrEqual(
      publishButton.getBoundingClientRect().left,
    );
    expect(publishButton.getBoundingClientRect().right).toBeLessThanOrEqual(
      trigger.getBoundingClientRect().left,
    );
    expect(diff.textContent).toContain("+2,819");
    expect(diff.textContent).toContain("−205");
    expect(getComputedStyle(diff).fontWeight).toBe("500");
    expect(getComputedStyle(diff).fontVariantNumeric).toBe("tabular-nums");
    expect(branchLabel.getBoundingClientRect().width).toBeGreaterThan(40);
    expect(branchLabel.getBoundingClientRect().height).toBeLessThanOrEqual(
      Number.parseFloat(getComputedStyle(branchLabel).lineHeight) + 1,
    );
    expect(getComputedStyle(branchLabel).textOverflow).toBe("clip");
    await waitForSolid(() => {
      expect(branchLabel.scrollWidth > branchLabel.clientWidth + 1).toBe(clipped);
      expect(getComputedStyle(branchLabel).maskImage !== "none").toBe(clipped);
    });
    expect(branchLabel.parentElement?.getAttribute("title")).toBe(branch.branch);
    const scrollPort = row.closest<HTMLElement>(".chat-details-desktop-body")!;
    expect(scrollPort.scrollWidth).toBeLessThanOrEqual(scrollPort.clientWidth + 1);

    const dismiss = page.getByRole("button", {
      name: `Hide ${branch.branch} for this session`,
      exact: true,
    });
    const menu = page.elementLocator(row.querySelector<HTMLElement>('[role="menu"]')!);
    await expect.element(menu).not.toBeVisible();
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(dismiss).toBeVisible();
    const personalChoice = page.getByRole("menuitemradio", { name: "@alice-tools", exact: true });
    await expect.element(personalChoice).toBeVisible();
    const personalElement = row.querySelector<HTMLElement>(
      '[role="menuitemradio"][value="personal"]',
    )!;
    expect(personalElement.closest('[role="menu"]')).toBe(
      row.querySelector(".chat-pr-branch-menu"),
    );
    await personalChoice.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("personal");
    await expect.element(menu).not.toBeVisible();
    await publish.click();
    expect(onPublish).toHaveBeenCalledOnce();
    expect(onDismissBranch).not.toHaveBeenCalled();
    await page.elementLocator(trigger).click();
    await dismiss.click();
    expect(onDismissBranch).toHaveBeenCalledExactlyOnceWith(branch);
    await expect.element(menu).not.toBeVisible();
  },
);

it.each([
  { width: 360, repo: "openclaw", checks: "passing", state: "merged" },
  {
    width: 300,
    repo: "a-very-long-repository-name-that-needs-truncation",
    checks: "pending",
    state: "draft",
  },
  {
    width: 220,
    repo: "a-very-long-repository-name-that-needs-truncation",
    checks: "failing",
    state: "closed",
  },
] as const)(
  "keeps title-first Details cards usable at $width px with $checks checks",
  async ({ width, repo, checks, state }) => {
    await page.viewport(800, 700);
    document.body.append(container);
    const onOpenSessionDiff = vi.fn();
    const pullRequest = {
      number: 173824,
      owner: "openclaw",
      repo,
      branch: "fix/sidebar-cards",
      title: "fix: keep long pull request titles readable in the session Details sidebar",
      url: "https://github.com/openclaw/" + repo + "/pull/173824",
      state: "open" as const,
      additions: 383,
      deletions: 441,
      checks: {
        state: checks,
        passed: 12,
        failed: checks === "failing" ? 1 : 0,
        skipped: 0,
        running: checks === "pending" ? 2 : 0,
      },
    };
    const sessionKey = `agent:main:cards-${width}`;
    const gateway = createApplicationGateway();
    gateway.publish({
      ...gateway.gateway.snapshot,
      phase: "connected",
      client: createTestGatewayClient(createGatewayRequestMock()),
      hello: gatewayHelloForMethods([]),
    });
    const context = createContext(gateway.gateway, createSessions("main", [sessionKey]));
    const activation = installRepositoryPresentation(context, () => ({
      pullRequests: [
        pullRequest,
        { ...pullRequest, number: 173825, state, url: pullRequest.url.replace("173824", "173825") },
      ],
      branch: sessionBranch({ repo, branch: pullRequest.branch, additions: 12, deletions: 3 }),
      status: "ready",
      rateLimited: false,
    }));
    mounted = mountSolid(
      () => (
        <>
          <style>{baseStyles + componentsStyles + layoutStyles + detailsStyles}</style>
          <section class="chat-details" style={"position:relative;width:" + width + "px"}>
            {createComponent(ChatDetailsSession, {
              presented: true,
              props: {
                sessionKey,
                selectedSession: undefined,
                currentAgentId: "main",
                messages: [],
                onOpenSessionDiff,
              },
            })}
          </section>
        </>
      ),
      { container, wrapper: createSolidApplicationContextProvider(activation.context).wrapper },
    );
    const host = container.querySelector("openclaw-chat-details-session")!;
    await host.updateComplete;
    await waitForSolid(() => expect(container.querySelector("a.chat-pr__link")).not.toBeNull());
    const group = container.querySelector<HTMLDetailsElement>(
      '[data-details-group="pull-requests"]',
    )!;
    const row = group.querySelector<HTMLElement>(".chat-pr")!;
    const title = row.querySelector<HTMLElement>(".chat-pr__link")!;
    const titleText = row.querySelector<HTMLElement>(".chat-pr__title")!;
    await expect.element(page.elementLocator(title)).toBeVisible();
    expect(title.getAttribute("href")).toBe(pullRequest.url);
    expect(title.getAttribute("aria-label")).toContain("openclaw/" + repo + "#173824");
    expect(titleText.textContent).toBe(pullRequest.title);
    const expectTitleFade = (overflow: boolean) =>
      waitForSolid(() => {
        expect(titleText.scrollWidth > titleText.clientWidth + 1).toBe(overflow);
        expect(getComputedStyle(titleText).maskImage !== "none").toBe(overflow);
      });
    await expectTitleFade(true);
    const details = container.querySelector<HTMLElement>(".chat-details")!;
    details.style.width = "1200px";
    await expectTitleFade(false);
    details.style.width = `${width}px`;
    await expectTitleFade(true);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    expect(container.querySelector<HTMLElement>(".chat-details")!.scrollWidth).toBeLessThanOrEqual(
      width,
    );
    expect(
      row
        .querySelector(".chat-pr__badge")
        ?.classList.contains(
          "chat-pr__badge--" +
            (checks === "failing" ? "failed" : checks === "pending" ? "running" : "passed"),
        ),
    ).toBe(true);
    expect(group.querySelectorAll(".chat-pr")).toHaveLength(2);
    expect(group.querySelectorAll(".chat-pr")[1]?.getAttribute("data-state")).toBe(state);
    // PR totals stay descriptive; the Environment diff opens this session’s changes.
    expect(row.querySelector("button.chat-pr__diff")).toBeNull();
    const changes = container.querySelector<HTMLButtonElement>(
      ".chat-environment__branch button.chat-pr__diff",
    )!;
    await expect.element(page.elementLocator(changes)).toBeVisible();
    expect(changes.textContent).toContain("+12");
    expect(changes.textContent).toContain("−3");
    expect(changes.closest("summary")).toBeNull();
    await expect
      .poll(() =>
        container
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity &&
              (animation.playState === "running" || animation.pending),
          ),
      )
      .toHaveLength(0);
    expect(changes.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      row.getBoundingClientRect().top,
    );
    await page.elementLocator(changes).click();
    expect(onOpenSessionDiff).toHaveBeenCalledOnce();
    expect(group.open).toBe(true);
    const summary = group.querySelector<HTMLElement>(":scope > summary")!;
    summary.focus();
    await userEvent.keyboard(" ");
    await expect.element(page.elementLocator(title)).not.toBeVisible();
    summary.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.elementLocator(title)).toBeVisible();
    const trigger = row.querySelector<HTMLButtonElement>(".chat-pr__actions button")!;
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const dismiss = page.getByRole("menuitem", {
      name: "Hide",
      exact: true,
    });
    await expect.element(dismiss).toBeVisible();
    const facts = row.querySelector<HTMLElement>(".chat-pr-menu__facts")!;
    expect(facts.querySelector(".chat-pr-menu__repository")?.textContent).toContain(
      "openclaw/" + repo,
    );
    expect(facts.querySelector(".chat-pr-menu__repository")?.textContent).toContain("#173824");
    expect(facts.textContent).toContain("+383");
    expect(facts.textContent).toContain("−441");
    expect(facts.textContent).toContain("Open");
    await userEvent.keyboard("{Escape}");
    const menu = row.querySelector<HTMLElement>('[role="menu"]')!;
    await expect.poll(() => menu.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await userEvent.keyboard("{Enter}");
    await expect.element(dismiss).toBeVisible();

    for (const id of ["checks", "monitoring"]) {
      await page.elementLocator(menu.querySelector<HTMLElement>(`[data-value="${id}"]`)!).click();
      await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("back");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe(id);
    }
    host.presented = false;
    await host.updateComplete;
    await expect.poll(() => menu.matches(":popover-open")).toBe(false);
    host.presented = true;
    await host.updateComplete;
    expect(menu.matches(":popover-open")).toBe(false);
    await page.elementLocator(trigger).click();
    await dismiss.click();
    await waitForSolid(() => expect(group.querySelectorAll(".chat-pr")).toHaveLength(1));
    expect(group.querySelector(".chat-pr__link")?.getAttribute("href")).toBe(
      pullRequest.url.replace("173824", "173825"),
    );
  },
);
