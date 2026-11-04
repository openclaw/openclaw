import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountConnect, type ConnectSnapshot } from "./connect.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});
const sessionId = "s".repeat(22);
const ready = {
  state: "pending",
  connectUrl: `https://connect.openclaw.ai/1password/start/${sessionId}`,
  confirmationCode: "M8AQ-KEGP",
  expiresAt: Date.now() + 600_000,
};
function mount(...responses: ConnectSnapshot[]) {
  const request =
    vi.fn<(method: string, params?: Record<string, unknown>) => Promise<ConnectSnapshot>>();
  for (const response of responses) {
    request.mockResolvedValueOnce(response);
  }
  const container = document.body.appendChild(document.createElement("div"));
  const mounted = mountConnect(container, {
    host: { request },
    signal: new AbortController().signal,
    props: {
      sessionKey: "agent:main:chat",
      agentId: "main",
      toolCallId: "call",
      toolName: "onepassword_autofill",
      payload: { sessionId },
    },
  });
  disposers.push(() => mounted.dispose());
  return { request, container };
}
const tick = async () => {
  await Promise.resolve();
  flush();
};

it("shows the code and link, then waits on the Gateway after the click until connected", async () => {
  vi.useFakeTimers();
  const f = mount(ready, { ...ready, openedAt: Date.now() }, { state: "connected" });
  await tick();
  expect(f.container.textContent).toContain("M8AQ-KEGP");
  const anchor = f.container.querySelector("a")!;
  expect(anchor.getAttribute("href")).toBe(ready.connectUrl);
  expect(anchor.getAttribute("target")).toBe("_blank");
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await tick();
  expect(f.request.mock.calls[1]?.[1]).toMatchObject({ action: "opened", sessionId });
  expect(f.container.textContent).toContain("Waiting for you to approve");
  await vi.advanceTimersByTimeAsync(2000);
  flush();
  expect(f.container.textContent).toContain("1Password connected");
  expect(f.container.querySelector("a")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("refuses links outside the OpenClaw connect page and explains a blocked connection", async () => {
  const f = mount({ ...ready, connectUrl: "javascript:synthetic" });
  await tick();
  expect(f.container.innerHTML).not.toContain("javascript:");
  const g = mount({ state: "failed", code: "disconnectExistingConnectionFirst" });
  await tick();
  expect(g.container.textContent).toContain("Disconnect it first");
});
