import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { waitForFast } from "../../test/wait-for.ts";
import type { WorkboardProps } from "./view-helpers.tsx";
import { buttonByLabel, createWorkboardView } from "./view.test-support.ts";

const provisional = "subagent:workboard-default-card-1";
const canonical = "agent:writer:existing";

function renderDetails(card: WorkboardCard, overrides: Partial<WorkboardProps> = {}) {
  const props = { canWrite: true, onOpenSession: vi.fn(), ...overrides };
  const view = createWorkboardView(props);
  const { state } = view;
  Object.assign(state, { cards: [card], detailCardId: card.id });
  view.renderView();
  const container = expectDefined(view.container.querySelector(".workboard-detail"), "detail");
  const button = (selector: string) =>
    expectDefined(container.querySelector<HTMLButtonElement>(selector), selector);
  return { state, props, container, button };
}

it.each([
  [canonical, "unknown", true],
  [canonical, "unavailable", true],
  [provisional, "unknown", false],
  [provisional, "ambiguous", false],
  ["global", "unknown", false],
  ["unknown", "unknown", false],
] as const)("keeps Edit recovery without replacement Start for %s (%s)", (key, status, canOpen) => {
  const card = createWorkboardCard({ sessionKey: key });
  const { container, state, props, button } = renderDetails(card, {
    sessionResolution: { key, status },
  });
  const open = buttonByLabel(container, "Open session");
  if (canOpen) {
    expectDefined(open, "canonical session action").click();
    expect(props.onOpenSession).toHaveBeenCalledWith({ sessionKey: key });
  } else {
    expect(open).toBeNull();
  }
  button('button[aria-label="Edit card"]').click();
  expect(state).toMatchObject({ draftOpen: true, draftSessionKey: key });
  expect(container.querySelectorAll(".workboard-card__start")).toHaveLength(0);
});

it.each([
  [provisional, `agent:writer:${provisional}`, undefined],
  [canonical, canonical, "writer"],
] as const)("stops %s's resolved owner after reassignment", async (key, sessionKey, agentId) => {
  const owner = { sessionKey, ...(agentId ? { agentId } : {}) };
  const session = createGatewaySession({ key: sessionKey, ...(agentId ? { agentId } : {}) });
  const card = createWorkboardCard({
    agentId: "main",
    sessionKey: key,
    status: "running",
    runId: "run",
  });
  const blocked = { ...card, status: "blocked", updatedAt: 2 };
  let aborts = 0;
  const client = createWorkboardTestClient((method) => {
    if (method === "chat.abort") {
      aborts += 1;
      return { aborted: !agentId || aborts > 1 };
    }
    if (method === "workboard.cards.update") {
      return { card: blocked };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { button, state } = renderDetails(card, {
    client,
    sessionResolution: { key, status: "resolved", session },
  });

  button('button[aria-label="Stop session"]').click();
  await waitForFast(() => expect(state.cards[0]?.status).toBe("blocked"));

  expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", { ...owner, runId: "run" });
  if (agentId) {
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", owner);
  }
  expect(state.error).toBeNull();
});

it.each(["start", "stop"] as const)("rejects stale %s after a link change", async (action) => {
  const session = createGatewaySession({ key: "agent:writer:original" });
  const card = createWorkboardCard(
    action === "stop" ? { sessionKey: session.key, status: "running" } : {},
  );
  const client = createWorkboardTestClient(() => {
    throw new Error("A retained action cannot operate on the replacement card");
  });
  const { button, state } = renderDetails(card, { client, sessions: [session] });
  const retained = button(
    action === "start" ? ".workboard-card__start--manual" : 'button[aria-label="Stop session"]',
  );
  const successor = {
    ...card,
    updatedAt: card.updatedAt + 1,
    sessionKey: "agent:writer:replacement",
  };
  state.cards = [successor];
  retained.click();
  await waitForFast(() => expect(state.error).toBeTruthy());

  expect(client.request).not.toHaveBeenCalled();
  expect(state.cards).toEqual([successor]);
  expect(state.busyCardIds.size).toBe(0);
});
