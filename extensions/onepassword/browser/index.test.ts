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

function fixture() {
  const abort = new AbortController();
  const request =
    vi.fn<(method: string, params?: Record<string, unknown>) => Promise<ApprovalSnapshot>>();
  const host = { request };
  const container = document.body.appendChild(document.createElement("div"));
  const context = {
    host,
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
    disposers.push(() => mounted?.dispose?.());
    return mounted;
  };
  return { abort, request, host, container, context, mount };
}
const tick = async () => {
  await Promise.resolve();
  flush();
};

it("registers the matching version and hydrates only the private viewer, then records an explicit click", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ state: "pending", appLink: "onepassword://synthetic-private" });
  f.request.mockResolvedValueOnce({ state: "pending", guidance: "Checking for your decision" });
  f.mount();
  expect(f.container.querySelector("a")).toBeNull();
  await tick();
  const anchor = f.container.querySelector("a")!;
  expect(anchor.getAttribute("href")).toBe("onepassword://synthetic-private");
  expect(f.request).toHaveBeenCalledWith("onepassword.autofill.approval", {
    requestId: "request",
    action: "get",
    sessionKey: "agent:main:chat",
    agentId: "main",
  });
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await tick();
  expect(f.request.mock.calls[1]?.[1]).toMatchObject({ action: "opened" });
  expect(f.container.querySelector("a")).toBeNull();
  expect(f.container.textContent).toContain("Checking for your decision");
});

it("clears the native URL on expiry and disposal and ignores stale hydration", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.request.mockResolvedValue({
    state: "pending",
    appLink: "onepassword://synthetic-private",
    expiresAt: Date.now() + 600_000,
  });
  const mounted = f.mount();
  await tick();
  await vi.advanceTimersByTimeAsync(600_000);
  flush();
  expect(f.container.querySelector("a")).toBeNull();
  expect(f.container.textContent).toContain("expired");
  mounted?.dispose?.();
  expect(f.container.innerHTML).toBe("");
  const late = fixture();
  const deferred = Promise.withResolvers<ApprovalSnapshot>();
  late.request.mockReturnValue(deferred.promise);
  const lateMount = late.mount();
  lateMount?.dispose?.();
  deferred.resolve({ state: "pending", appLink: "onepassword://synthetic-private" });
  await tick();
  expect(late.container.innerHTML).toBe("");
});

it("rejects executable non-1Password URLs and shows an actionable owner error without the link", async () => {
  const f = fixture();
  f.request.mockResolvedValue({ state: "pending", appLink: "javascript:synthetic" });
  f.mount();
  await tick();
  expect(f.container.querySelector("a")).toBeNull();
  expect(f.container.textContent).toContain("owner access");
  expect(f.container.innerHTML).not.toContain("javascript:");
});
