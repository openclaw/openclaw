import type { ControlUiSessionPullRequestCheckDetails } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { createMenuControls } from "../../../../ui/src/components/solid/menu.tsx";
import { waitForSolid } from "../../../../ui/src/test-helpers/solid-settle.ts";
import { createDeferred } from "./deferred.test-support.ts";
import { createGatewayHarness } from "./session-pull-requests.test-support.ts";
import "./repository-ci.test-support.tsx";

const pullRequest = {
  owner: "example",
  repo: "project",
  number: 42,
  branch: "feature",
  title: "CI details",
  state: "open" as const,
  url: "https://github.com/example/project/pull/42",
  headSha: "a".repeat(40),
};

function details(
  name: string,
  headSha = pullRequest.headSha,
): ControlUiSessionPullRequestCheckDetails {
  return {
    owner: pullRequest.owner,
    repo: pullRequest.repo,
    number: pullRequest.number,
    headSha,
    status: "ready",
    rateLimited: false,
    checks: [{ id: 1, name, source: "actions", state: "failed", status: "completed", steps: [] }],
  };
}

function mount(pending: Promise<ControlUiSessionPullRequestCheckDetails>) {
  const harness = createGatewayHarness();
  harness.request.mockReturnValue(pending);
  const element = document.createElement("oc-test-ci-details");
  Object.assign(element, {
    gateway: harness.gateway,
    pullRequest,
    sessionKey: "agent:main:dashboard:ci-details",
    inline: true,
  });
  document.body.append(element);
  onTestFinished(() => element.remove());
  return { element, request: harness.request };
}

it("shows a delayed read, its failure, and a successful explicit retry", async () => {
  const read = createDeferred<ControlUiSessionPullRequestCheckDetails>();
  const { element, request } = mount(read.promise);
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("true");
  });
  read.reject(new Error("CI fixture unavailable"));
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__notice")?.textContent).toContain(
      "CI fixture unavailable",
    );
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("false");
  });
  request.mockResolvedValueOnce(details("Recovered check"));
  element.querySelector<HTMLButtonElement>(".chat-ci__retry")!.click();
  await waitForSolid(() => {
    expect(element.querySelector(".chat-ci__job")?.textContent).toContain("Recovered check");
    expect(element.querySelector<HTMLDetailsElement>(".chat-ci__job")?.open).toBe(true);
    expect(element.querySelector(".chat-ci__jobs")?.getAttribute("aria-busy")).toBe("false");
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("aborts a retired head read and ignores its late answer", async () => {
  const oldRead = createDeferred<ControlUiSessionPullRequestCheckDetails>();
  const { element, request } = mount(oldRead.promise);
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
  const signal = request.mock.calls[0]?.[2]?.signal;
  const nextHead = "b".repeat(40);
  request.mockResolvedValueOnce(details("Current head", nextHead));
  element.pullRequest = { ...pullRequest, headSha: nextHead };
  // The native bridge publishes component inputs on the Solid receipt.
  await element.updateComplete;
  expect(signal?.aborted).toBe(true);
  await waitForSolid(() => expect(element.textContent).toContain("Current head"));
  oldRead.resolve(details("Retired head"));
  await element.updateComplete;
  await waitForSolid(() => {
    expect(element.textContent).toContain("Current head");
    expect(element.textContent).not.toContain("Retired head");
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("moves mounted CI controls to the current menu owner and releases them on removal", async () => {
  const first = createMenuControls();
  const second = createMenuControls();
  const result = details("Failed check");
  result.checks[0]!.detailsUrl = "https://github.com/example/project/actions/runs/1";
  result.checks.push({
    id: 2,
    name: "Skipped check",
    source: "actions",
    state: "skipped",
    status: "completed",
  });
  const { element } = mount(Promise.resolve(result));
  element.controls = first;
  element.menuControls = true;
  const renderedControls = () =>
    Array.from(
      element.querySelectorAll<HTMLElement>(
        ".chat-ci__job-summary, .chat-ci__job-link, .chat-ci__skipped > summary",
      ),
    );
  await waitForSolid(() => {
    expect(first.elements.size).toBe(4);
    expect([...first.elements]).toEqual(expect.arrayContaining(renderedControls()));
  });
  element.controls = second;
  await waitForSolid(() => {
    expect(first.elements.size).toBe(0);
    expect(second.elements.size).toBe(4);
    expect([...second.elements]).toEqual(expect.arrayContaining(renderedControls()));
  });
  element.remove();
  await waitForSolid(() => expect(second.elements.size).toBe(0));
});

it("shares native subscriptions across closed CI pairs while retaining ordered events", async () => {
  const harness = createGatewayHarness();
  const rows = Array.from({ length: 100 }, () => {
    const root = document.createElement("details");
    root.className = "chat-pr__checks";
    const props = {
      gateway: harness.gateway,
      pullRequest,
      sessionKey: "agent:main:dashboard:ci-shared",
    };
    root.append(
      Object.assign(document.createElement("oc-test-ci-details"), props),
      Object.assign(document.createElement("oc-test-ci-automation"), props, {
        sessionId: "ci-shared",
      }),
    );
    document.body.append(root);
    return root;
  });
  onTestFinished(() => rows.forEach((row) => row.remove()));
  await waitForSolid(() => expect(harness.subscribeEvents).toHaveBeenCalledTimes(100));
  expect(harness.subscribeSnapshots).toHaveBeenCalledOnce();
  expect(harness.request).not.toHaveBeenCalled();
  rows.slice(0, 99).forEach((row) => row.remove());
  await waitForSolid(() => expect(harness.unsubscribeEvents).toHaveBeenCalledTimes(99));
  expect(harness.unsubscribeSnapshots).not.toHaveBeenCalled();
  rows[99]!.remove();
  await waitForSolid(() => expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce());
});
