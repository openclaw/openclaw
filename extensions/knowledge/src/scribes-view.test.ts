/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { Page } from "./page-context.js";
import { scribeSetup, setupMessage } from "./scribes-catalog.js";
import { scribes } from "./scribes-view.js";

type Call = [string, Record<string, unknown> | undefined];
const reviewJob = {
  id: "job-review",
  declarationKey: "knowledge:scribe:unlinked-review",
  enabled: true,
  configRevision: "rev-7",
  schedule: { kind: "cron", expr: "45 3 * * *" },
  failureAlert: { after: 2 },
  state: { lastRunStatus: "ok", lastRunAtMs: 1_793_000_000_000, nextRunAtMs: 1_793_090_000_000 },
};

// A fake page host: Gateway reads answer from `world`; writes are recorded.
function fixture(world: {
  sessions?: Record<string, { key: string; label: string; archived?: boolean }>;
  jobs?: unknown[];
  canWrite?: boolean;
}) {
  // HTMLDialogElement is incomplete in jsdom.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  const calls: Call[] = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params]);
    switch (method) {
      case "cron.list":
        return { jobs: world.jobs ?? [], hasMore: false, nextOffset: null };
      case "sessions.list": {
        if (typeof params?.label === "string") {
          const row = world.sessions?.[params.label];
          return { sessions: row ? [row] : [] };
        }
        return { sessions: [], count: 1, totalCount: params?.archived ? 1204 : 148 };
      }
      case "chat.history":
        return { messages: [] };
      case "cron.runs":
        return {
          entries: [
            {
              ts: 1_793_000_000_000,
              status: "ok",
              summary: "9 filed · 2 pages created",
              model: "anthropic/claude",
            },
          ],
        };
      case "agents.files.list":
        return { files: [{ name: "MEMORY.md", missing: false, size: 8192 }] };
      default:
        return { ok: true };
    }
  });
  const create = vi.fn(async () => "agent:main:dock:new");
  const open = vi.fn();
  const connection = { connected: true, canRead: true, canWrite: world.canWrite ?? true };
  const host = { request, connection, sessions: { create, open } };
  const load = vi.fn(async () => true);
  const scribesTab = document.createElement("button");
  const ui = {
    s: { context: { host }, scribe: "", storesSnapshot: undefined },
    live: () => true,
    viewedAgent: () => "main",
    displayName: (id: string) => (id === "main" ? "Main" : id),
    announce: vi.fn(),
    errorText: (error: unknown) => String(error),
    load,
    scribesTab,
  } as unknown as Page;
  const page = document.createElement("section");
  page.className = "knowledge-page";
  document.body.append(page);
  const render = async () => {
    const target = document.createElement("div");
    await scribes(ui, 1, target);
    page.replaceChildren(target);
    return target;
  };
  return { ui, calls, request, create, open, load, render, page, scribesTab };
}
const buttonNamed = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

afterEach(() => document.body.replaceChildren());

it("lists On and Available scribes with honest detection and a tab count", async () => {
  const { render, scribesTab } = fixture({
    sessions: {
      "Scribe · Review unlinked claims": {
        key: "s-review",
        label: "Scribe · Review unlinked claims",
      },
    },
    jobs: [reviewJob],
  });
  const view = await render();
  expect([...view.querySelectorAll(".knowledge-eyebrow")].map((n) => n.textContent)).toEqual([
    "On · 1",
    "Available · 2",
  ]);
  expect(view.textContent).toContain("148 active · 1,204 archived conversations on Main");
  expect(view.textContent).toContain("Found Memory on Main · MEMORY.md 8 KB");
  expect(view.querySelector(".scribe-chip-on")?.textContent).toBe("On");
  expect(scribesTab.textContent).toBe("Scribes1");
});

it("starts a conversations scribe: creates its labelled conversation and sends the setup message", async () => {
  const { render, create, calls, ui, load, page } = fixture({});
  const view = await render();
  buttonNamed(view, "Set up…").click();
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("148 conversations in your sidebar.");
  (dialog.querySelector("#scribe-often-once") as HTMLInputElement).click();
  (dialog.querySelector("#scribe-which-all") as HTMLInputElement).click();
  const select = dialog.querySelector("select")!;
  select.value = "90d";
  select.dispatchEvent(new Event("change"));
  expect(dialog.textContent).toContain("Nothing is scheduled.");
  buttonNamed(dialog, "Start").click();
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith({
    agentId: "main",
    label: "Scribe · Learn from conversations",
    surface: "plugin-dock",
  });
  const send = calls.find(([method]) => method === "chat.send")![1]!;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(send).toEqual({
    sessionKey: "agent:main:dock:new",
    agentId: "main",
    message: setupMessage(
      scribeSetup("conversations", "once", { scope: "all", since: "90d" }, "main", timezone),
    ),
    idempotencyKey: "knowledge:scribe:conversations:agent:main:dock:new",
  });
  expect(ui.s.scribe).toBe("conversations");
  expect(page.querySelector("dialog")).toBeNull();
});

it("keeps the start dialog open with the error when the Gateway rejects the start", async () => {
  const { render, request, page } = fixture({});
  const view = await render();
  request.mockImplementationOnce(async () => {
    throw new Error("missing scope: operator.write");
  });
  buttonNamed(view, "Import…").click();
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("8 KB in Main’s workspace.");
  buttonNamed(dialog, "Start import").click();
  await vi.waitFor(() =>
    expect(dialog.querySelector(".knowledge-error")?.textContent).toContain("missing scope"),
  );
  expect(dialog.open).toBe(true);
});

it("disables starting without write access", async () => {
  const { render, page } = fixture({ canWrite: false });
  const view = await render();
  const setUp = buttonNamed(view, "Set up…");
  expect(setUp.disabled).toBe(true);
  setUp.disabled = false;
  setUp.click();
  const dialog = page.querySelector("dialog")!;
  expect(buttonNamed(dialog, "Start").disabled).toBe(true);
  expect(dialog.textContent).toContain("needs write access");
});

it("runs, pauses, turns off and opens an On scribe from its detail", async () => {
  const { render, ui, calls, open, load, page } = fixture({
    sessions: {
      "Scribe · Review unlinked claims": {
        key: "s-review",
        label: "Scribe · Review unlinked claims",
      },
    },
    jobs: [reviewJob],
  });
  ui.s.scribe = "unlinked-review";
  const view = await render();
  expect(view.textContent).toContain("1 recent run, all succeeded");
  expect(view.textContent).toContain("9 filed · 2 pages created");
  expect(view.textContent).toContain("Alert after 2 failed runs");
  buttonNamed(view, "Run now").click();
  await flush();
  expect(calls.at(-1)).toEqual(["cron.run", { id: "job-review", mode: "force" }]);
  buttonNamed(view, "Pause").click();
  await flush();
  expect(calls.at(-1)).toEqual([
    "cron.update",
    { id: "job-review", patch: { enabled: false }, expectedConfigRevision: "rev-7" },
  ]);
  buttonNamed(view, "Open conversation").click();
  expect(open).toHaveBeenCalledWith({ sessionKey: "s-review", agentId: "main" });
  buttonNamed(view, "Turn off…").click();
  const confirm = page.querySelector("dialog")!;
  buttonNamed(confirm, "Turn off").click();
  await vi.waitFor(() =>
    expect(calls.at(-1)).toEqual([
      "cron.remove",
      { id: "job-review", expectedConfigRevision: "rev-7" },
    ]),
  );
  expect(load).toHaveBeenCalled();
});

it("repairs a scribe whose conversation was archived", async () => {
  const { render, ui, calls } = fixture({
    sessions: {
      "Scribe · Review unlinked claims": {
        key: "s-review",
        label: "Scribe · Review unlinked claims",
        archived: true,
      },
    },
    jobs: [reviewJob],
  });
  ui.s.scribe = "unlinked-review";
  const view = await render();
  expect(view.querySelector(".scribe-chip-warn")?.textContent).toBe("Needs reauthorization");
  expect(buttonNamed(view, "Run now")).toBeUndefined();
  buttonNamed(view, "Repair").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("chat.send"));
  expect(calls.at(-2)).toEqual([
    "sessions.patch",
    { key: "s-review", agentId: "main", archived: false },
  ]);
  const send = calls.at(-1)![1]!;
  expect(String(send.message)).toMatch(/^Knowledge scribe repair: unlinked-review\n/);
  expect(String(send.idempotencyKey)).toMatch(/^knowledge:scribe:unlinked-review:repair:/);
});
