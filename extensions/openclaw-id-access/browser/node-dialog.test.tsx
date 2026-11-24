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

const joinLink = "openclaw-node://join#i=synthetic";

it("creates, waits with a countdown, then expires without exposing a stale link", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const create = vi.fn().mockResolvedValue({
    inviteId: "test",
    expiresAt: 102,
    joinLink,
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
  expect(document.body.textContent).toContain("Create invite");
  const input = document.querySelector("input")!;
  input.value = "Builder";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  button("Create invite").click();
  await Promise.resolve();
  flush();
  expect(create).toHaveBeenCalledWith("Builder");
  expect(document.body.textContent).toContain("Waiting for the device");
  expect(document.body.textContent).toContain("0:02");
  // The friendly route comes first; shell commands stay under a disclosure.
  expect(button("Copy invite link")).toBeDefined();
  expect(document.querySelector("pre code")?.textContent).toBe(joinLink);
  const details = document.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe("Use the command line");
  expect(details.textContent).toContain("npx synthetic");
  await vi.advanceTimersByTimeAsync(2000);
  flush();
  expect(document.body.textContent).toContain("invitation expired");
  expect(document.body.textContent).not.toContain("npx synthetic");
  expect(document.body.textContent).not.toContain(joinLink);
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

it("keeps the invite link but shows Discovery guidance under the command line", async () => {
  dispose = render(
    () => (
      <NodeDialog
        host={host}
        disabled={false}
        canCreate
        onCreate={() =>
          Promise.resolve({ inviteId: "test", expiresAt: 9999999999, joinLink, commands: null })
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
  button("Create invite").click();
  await Promise.resolve();
  flush();
  expect(document.body.textContent).toContain(
    "Configure the OpenClaw ID Discovery address on the Gateway to get a command",
  );
  expect(document.querySelectorAll("pre")).toHaveLength(1);
  expect(button("Copy invite link")).toBeDefined();
  expect(button("Copy command")).toBeUndefined();
});

it("discards a command completed after its originating dialog closes", async () => {
  type Made = { inviteId: string; expiresAt: number; joinLink: string; commands: null };
  let finish!: (value: Made) => void;
  const pendingCreate = new Promise<Made>((resolve) => {
    finish = resolve;
  });
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
  button("Create invite").click();
  button("Close").click();
  flush();
  finish({ inviteId: "test", expiresAt: 9999999999, joinLink, commands: null });
  await Promise.resolve();
  flush();
  expect(onCreated).not.toHaveBeenCalled();
  expect(document.body.textContent).toBe("");
});
