import "../../test/dom.setup.ts";
import { render as litRender } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { renderWorkboard } from "./view.ts";

const renderedRoots = new Set<ReturnType<typeof litRender>>();

afterEach(() => {
  for (const root of renderedRoots) {
    root.setConnected(false);
  }
  renderedRoots.clear();
});

function mountBoard(client: GatewayBrowserClient) {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  const container = document.createElement("div");
  document.body.append(container);
  const renderBoard = () => {
    workboardTestHost().connection.connected = true;
    renderedRoots.add(
      litRender(
        renderWorkboard({
          host,
          client,
          connected: true,
          agentsList: null,
          sessions: [],
          onOpenSession: () => undefined,
          onRefresh: () => undefined,
        }),
        container,
      ),
    );
  };
  const statusControl = (title: string) =>
    container.querySelector<HTMLSelectElement>(
      `.workboard-card__move-select[aria-label="Status: ${title}"]`,
    );
  return { state, renderBoard, statusControl };
}

describe("workboard card status control", () => {
  it("keeps the card behind a moved card on its own status", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => ({
      card: {
        ...createWorkboardCard({ id: "card-1", title: "Leaves the column" }),
        status: (params as { status: string }).status,
        position: 3000,
        updatedAt: 2,
      },
    }));
    const { state, renderBoard, statusControl } = mountBoard({
      request,
    } as unknown as GatewayBrowserClient);
    state.cards = [
      createWorkboardCard({ id: "card-1", title: "Leaves the column", position: 1000 }),
      createWorkboardCard({ id: "card-2", title: "Stays behind", position: 2000 }),
    ];
    renderBoard();
    const moving = statusControl("Leaves the column");
    expect(moving?.value).toBe("todo");

    moving!.value = "blocked";
    moving!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    renderBoard();

    // The moved card leaves the Todo column, so Lit reuses its control element for
    // the card behind it. The reused element must show that card's own status.
    expect(statusControl("Stays behind")?.value).toBe("todo");
    expect(statusControl("Leaves the column")?.value).toBe("blocked");
  });
});
