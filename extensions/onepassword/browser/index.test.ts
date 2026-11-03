import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountApproval, type ApprovalSnapshot } from "./index.js";

type Context = Parameters<typeof mountApproval>[1];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});
const metadata = {
  goal: "Download an invoice",
  entries: [{ domain: "example.com", reason: "Download the invoice", granted: false }],
};
const ready = { ...metadata, state: "pending", appLink: "onepassword://synthetic-private" };
function fixture() {
  const abort = new AbortController();
  const request =
    vi.fn<(method: string, params?: Record<string, unknown>) => Promise<ApprovalSnapshot>>();
  const container = document.body.appendChild(document.createElement("div"));
  const context = {
    host: { request },
    signal: abort.signal,
    props: {
      sessionKey: "agent:main:chat",
      agentId: "main",
      toolCallId: "call",
      toolName: "onepassword_autofill",
      payload: { requestId: "request" },
    },
  } satisfies Context;
  const mount = () => {
    const mounted = mountApproval(container, context);
    disposers.push(() => mounted.dispose());
    return mounted;
  };
  return { abort, request, container, context, mount };
}
const tick = async () => {
  await Promise.resolve();
  flush();
};

it("hydrates private metadata and link, then observes only the Gateway while waiting and stops on approval", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.request
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({ ...ready, openedAt: Date.now(), deadline: Date.now() + 120_000 });
  f.mount();
  expect(f.container.querySelector("a")).toBeNull();
  await tick();
  expect(f.container.textContent).toContain("Download the invoice");
  expect(f.container.textContent).not.toContain("pending");
  expect(f.container.textContent).not.toContain("Refresh status");
  expect(f.request).toHaveBeenCalledWith("onepassword.autofill.approval", {
    requestId: "request",
    action: "get",
    sessionKey: "agent:main:chat",
    agentId: "main",
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.request).toHaveBeenCalledTimes(1);
  const anchor = f.container.querySelector("a")!;
  expect(anchor.getAttribute("href")).toBe(ready.appLink);
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await tick();
  expect(f.request.mock.calls[1]?.[1]).toMatchObject({ action: "opened" });
  expect(f.container.textContent).toContain("Waiting for you in 1Password");
  expect(f.container.textContent).toContain("1:58");
  f.request.mockResolvedValue({
    ...metadata,
    state: "resolved",
    entries: [{ domain: "example.com", granted: true }],
  });
  await vi.advanceTimersByTimeAsync(2000);
  flush();
  expect(f.container.textContent).toContain("OpenClaw can sign in to example.com");
  expect(f.container.querySelector("a")).toBeNull();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.request).toHaveBeenCalledTimes(3);
});

it("clears the URL on deadline and disposal, ignores late hydration and releases waiting timers", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.request.mockResolvedValue({
    ...ready,
    openedAt: Date.now() - 119_000,
    deadline: Date.now() + 1000,
  });
  const mounted = f.mount();
  await tick();
  const final = Promise.withResolvers<ApprovalSnapshot>();
  f.request.mockReturnValueOnce(final.promise);
  await vi.advanceTimersByTimeAsync(1000);
  flush();
  expect(f.container.querySelector("a")).toBeNull();
  expect(f.container.textContent).toContain("Checking your decision");
  expect(vi.getTimerCount()).toBe(0);
  final.resolve({ state: "resolved", entries: [{ domain: "example.com", granted: true }] });
  await tick();
  expect(f.container.textContent).toContain("Sign-in approved");
  mounted.dispose();
  expect(f.container.innerHTML).toBe("");
  const late = fixture();
  const deferred = Promise.withResolvers<ApprovalSnapshot>();
  late.request.mockReturnValue(deferred.promise);
  late.mount().dispose();
  deferred.resolve(ready);
  await tick();
  expect(late.container.innerHTML).toBe("");
  const waiting = fixture();
  waiting.request.mockResolvedValue({
    ...ready,
    openedAt: Date.now(),
    deadline: Date.now() + 120_000,
  });
  const waitingMount = waiting.mount();
  await tick();
  waiting.container.querySelector<HTMLButtonElement>("button")!.click();
  flush();
  expect(waiting.container.textContent).toContain("Open this on a computer with 1Password");
  expect(waiting.container.querySelector("a")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  waitingMount.dispose();
});

it("rejects executable non-1Password URLs and gives an actionable owner error without the link", async () => {
  const f = fixture();
  f.request.mockResolvedValue({ state: "pending", appLink: "javascript:synthetic" });
  f.mount();
  await tick();
  expect(f.container.querySelector("a")).toBeNull();
  expect(f.container.textContent).toContain("owner access");
  expect(f.container.innerHTML).not.toContain("javascript:");
});
