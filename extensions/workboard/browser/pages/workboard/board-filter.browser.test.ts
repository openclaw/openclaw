import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createControlUiComponents } from "../../../../../ui/src/plugins/control-ui-components.ts";
import {
  createContext,
  createGateway,
  createSessions,
} from "../../../../../ui/src/test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../../../../ui/src/test-helpers/gateway-client.ts";
import { loadWorkboard } from "../../lib/workboard/loading.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createWorkboardView } from "./view.test-support.ts";

it("shows full board totals before and after loading the remaining card page", async () => {
  const cards = Array.from({ length: 175 }, (_, index) =>
    createWorkboardCard({
      id: String(index),
      position: index,
      ...(index >= 150
        ? { metadata: { automation: { boardId: "ops" } } }
        : index === 149
          ? { metadata: { archivedAt: 1 } }
          : {}),
    }),
  );
  const boards = [
    { id: "default", total: 150, active: 149, archived: 1, byStatus: { todo: 150 } },
    { id: "ops", name: "Operations", total: 25, active: 25, archived: 0, byStatus: { todo: 25 } },
  ];
  const client = createWorkboardTestClient((_method, params) => {
    const more = Boolean((params as { after?: unknown }).after);
    return {
      cards: more ? cards.slice(100) : cards.slice(0, 100),
      boards,
      statuses: ["todo"],
      ...(!more ? { nextCursor: { position: 99, createdAt: 1, id: "99" } } : {}),
    };
  });
  const context = createContext(
    createGateway(createTestGatewayClient(() => ({}))),
    createSessions("main", []),
  );
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  const onError = vi.fn();
  const components = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  });
  // Keep unrelated host controls bounded, but exercise the shipped select picker.
  workboardTestHost().host.components.mountSelectPicker = components.mountSelectPicker;
  const panel = createWorkboardView({ client });
  await loadWorkboard({ host: panel.host, client, force: true });
  panel.renderView();
  const openBoards = async () => {
    await userEvent.click(
      panel.container.querySelector<HTMLButtonElement>(".workboard-filter-trigger")!,
    );
    await page.getByRole("button", { name: "Filter by board: All boards", exact: true }).click();
  };
  const expectTotals = async () => {
    const descriptions = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
        (option) => option.textContent,
      );
    await expect
      .poll(descriptions, { timeout: 2000 })
      .toEqual(
        expect.arrayContaining([
          "Default board149 active · 150 total",
          "Operations (ops)25 active · 25 total",
        ]),
      );
  };
  await openBoards();
  await expectTotals();
  await userEvent.keyboard("{Escape}{Escape}");
  await page.getByRole("button", { name: "Load more cards", exact: true }).click();
  await expect.poll(() => panel.state.cards.length).toBe(175);
  await openBoards();
  await expectTotals();
  expect(onError).not.toHaveBeenCalled();
});
