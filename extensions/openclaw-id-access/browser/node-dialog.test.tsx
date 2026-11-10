/* @vitest-environment jsdom */
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { NodeDialog } from "./node-dialog.js";
import type { NodeInvite } from "./types.js";

const pending: NodeInvite = {
  inviteId: "test",
  label: "Build machine",
  createdAt: 1,
  expiresAt: 9999999999,
  status: "pending",
  pending: {
    peerKey: `iroh:${"a".repeat(64)}`,
    requestedAt: 1,
    decideBy: 9999999999,
    verificationCode: "004219",
    description: {
      display_name: "<b>Builder</b>",
      platform: "linux",
      commands: ["system.run", "browser.proxy", "fs.read", "system.execApprovals.get"],
      caps: ["browser"],
    },
  },
};
const disposeShell = vi.fn();
// Only the modal platform shell is substituted; NodeDialog owns the real Solid subtree.
const host = {
  components: {
    mountDialog: (container: HTMLElement, props: { content: HTMLElement }) => {
      container.append(props.content);
      return { update() {}, dispose: disposeShell };
    },
  },
};
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.useRealTimers();
  disposeShell.mockClear();
});
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent === name)!;

it("creates, waits with a countdown, then expires without exposing a stale command", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const create = vi.fn().mockResolvedValue({
    inviteId: "test",
    expiresAt: 102,
    commands: { command: "npx synthetic", installedCommand: "openclaw synthetic" },
  });
  const decide = vi.fn();
  dispose = render(
    () => (
      <NodeDialog
        host={host}
        disabled={false}
        canCreate
        onCreate={create}
        onDecide={decide}
        onClose={() => {}}
      />
    ),
    document.body,
  );
  flush();
  expect(document.body.textContent).toContain("Create node command");
  const input = document.querySelector("input")!;
  input.value = "Builder";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  button("Create node command").click();
  await Promise.resolve();
  flush();
  expect(create).toHaveBeenCalledWith("Builder");
  expect(document.body.textContent).toContain("Waiting for the node");
  expect(document.body.textContent).toContain("0:02");
  expect(document.body.textContent).toContain("npx synthetic");
  await vi.advanceTimersByTimeAsync(2000);
  flush();
  expect(document.body.textContent).toContain("invitation expired");
  expect(document.body.textContent).not.toContain("npx synthetic");
  expect(decide).not.toHaveBeenCalled();
  dispose();
  dispose = undefined;
  expect(disposeShell).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "requires an explicit decision with the code and full surface visible (approve=%s)",
  async (approve) => {
    const decide = vi.fn().mockResolvedValue(true);
    const [invite, setInvite] = createSignal<NodeInvite | undefined>();
    dispose = render(
      () => (
        <NodeDialog
          host={host}
          invite={invite()}
          disabled={false}
          canCreate
          onCreate={() => Promise.resolve(undefined)}
          onDecide={decide}
          onClose={() => {}}
        />
      ),
      document.body,
    );
    setInvite(pending);
    flush();
    expect(document.body.textContent).toContain("004-219");
    expect(document.body.textContent).toContain("Compare all 6 digits");
    expect(document.body.textContent).toContain("<b>Builder</b>");
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelectorAll("li.danger")).toHaveLength(4);
    expect(document.body.textContent).toContain("browser");
    expect(decide).not.toHaveBeenCalled();
    button(approve ? "Codes match — approve node" : "Deny node").click();
    await Promise.resolve();
    flush();
    expect(decide).toHaveBeenCalledWith(pending, approve);
    expect(document.body.textContent).toContain(approve ? "Node approved" : "Node denied");
    expect(document.body.textContent).not.toContain("004-219");
  },
);

it("shows Discovery setup guidance without a copyable command", async () => {
  dispose = render(
    () => (
      <NodeDialog
        host={host}
        disabled={false}
        canCreate
        onCreate={() =>
          Promise.resolve({ inviteId: "test", expiresAt: 9999999999, commands: null })
        }
        onDecide={() => Promise.resolve(undefined)}
        onClose={() => {}}
      />
    ),
    document.body,
  );
  flush();
  const input = document.querySelector("input")!;
  input.value = "Builder";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  button("Create node command").click();
  await Promise.resolve();
  flush();
  expect(document.body.textContent).toContain(
    "Configure the OpenClaw ID Discovery address on the Gateway first",
  );
  expect(document.querySelector("pre")).toBeNull();
  expect(button("Copy command")).toBeUndefined();
});

it("discards a command completed after its originating dialog closes", async () => {
  let finish!: (value: { inviteId: string; expiresAt: number; commands: null }) => void;
  const pendingCreate = new Promise<{ inviteId: string; expiresAt: number; commands: null }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const onCreated = vi.fn();
  dispose = render(
    () => (
      <NodeDialog
        host={host}
        disabled={false}
        canCreate
        onCreate={() => pendingCreate}
        onCreated={onCreated}
        onDecide={() => Promise.resolve(undefined)}
        onClose={() => {
          dispose?.();
          dispose = undefined;
        }}
      />
    ),
    document.body,
  );
  flush();
  const input = document.querySelector("input")!;
  input.value = "Builder";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  button("Create node command").click();
  button("Close").click();
  flush();
  finish({ inviteId: "test", expiresAt: 9999999999, commands: null });
  await Promise.resolve();
  flush();
  expect(onCreated).not.toHaveBeenCalled();
  expect(document.body.textContent).toBe("");
});
