import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { WorkboardCatalog } from "./catalog.ts";
import { bindWorkboardHost } from "./host.ts";
import { workboardBoardName } from "./lib/workboard/board-presentation.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { WORKBOARD_CHANGED_EVENT, type WorkboardBoardSummary } from "./lib/workboard/types.ts";
import { createWorkboardPage, workboardPageTarget } from "./pages/workboard/workboard-page.ts";
import { createWorkboardSessionAccessory } from "./session-accessory.ts";
import { createWorkboardWidget } from "./widgets.ts";
import "./styles/workboard.css";
import "./styles/widgets.css";
import "./styles/session-chip.css";

type NavigationBoard = Pick<WorkboardBoardSummary, "id" | "name" | "kind" | "icon" | "color">;

export default defineControlUiPlugin({
  id: "workboard",
  activate(host) {
    const unbind = bindWorkboardHost(host);
    const workboard = createWorkboardCapability();
    const client = host;
    const navigation = new Map<
      string,
      { board: NavigationBoard; order: number; signature: string; dispose: () => void }
    >();
    const syncBoardNavigation = (boards: readonly NavigationBoard[]) => {
      const nameCounts = new Map<string, number>();
      for (const board of boards) {
        const name = workboardBoardName(board);
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const currentIds = new Set(boards.map((board) => board.id));
      for (const [id, entry] of navigation) {
        if (!currentIds.has(id)) {
          entry.dispose();
          navigation.delete(id);
        }
      }
      for (const [index, board] of boards.entries()) {
        const name = workboardBoardName(board);
        const label = (nameCounts.get(name) ?? 0) > 1 ? `${name} (${board.kind ?? "cards"})` : name;
        const order = 20 + index;
        const signature = JSON.stringify([label, board.icon, board.color, order]);
        const entry = navigation.get(board.id);
        if (entry?.signature === signature) {
          entry.board = board;
          continue;
        }
        entry?.dispose();
        navigation.set(board.id, {
          board,
          order,
          signature,
          dispose: host.ui.registerNavigation({
            id: `board-${board.id}`,
            parent: "workboard",
            label,
            page: workboardPageTarget(board.id),
            icon: board.icon,
            order,
            defaultVisible: false,
          }),
        });
      }
    };
    const catalog = new WorkboardCatalog(({ boards }) => syncBoardNavigation(boards), workboard);
    const registrations = [
      host.ui.registerPage({
        id: "workboard",
        label: "Workboard",
        mount: createWorkboardPage(workboard, (board) => {
          const boards = [...navigation.values()]
            .toSorted((left, right) => left.order - right.order)
            .map((entry) => entry.board);
          const index = boards.findIndex((entry) => entry.id === board.id);
          boards[index < 0 ? boards.length : index] = board;
          syncBoardNavigation(boards);
        }),
      }),
      host.ui.registerNavigation({
        id: "workboard",
        label: "Workboard",
        page: workboardPageTarget(),
        icon: "kanban",
        order: 10,
      }),
      host.ui.registerAccessory({
        id: "linked-card",
        placement: "session-header",
        mount: createWorkboardSessionAccessory(workboard),
      }),
      ...(["mini", "card", "board"] as const).map((id) =>
        host.ui.registerWidget({
          id,
          label:
            id === "mini"
              ? "Workboard summary"
              : id === "card"
                ? "Workboard card"
                : "Workboard board",
          mount: createWorkboardWidget(host, id),
        }),
      ),
      workboard.subscribe(host.ui.invalidate),
      host.subscribe(() => catalog.sync(client, host.connection.connected)),
      host.onEvent(WORKBOARD_CHANGED_EVENT, () =>
        catalog.handleGatewayEvent(WORKBOARD_CHANGED_EVENT),
      ),
    ];
    catalog.sync(client, host.connection.connected);
    return () => {
      for (const dispose of registrations.toReversed()) {
        dispose();
      }
      for (const { dispose } of navigation.values()) {
        dispose();
      }
      catalog.dispose();
      workboard.dispose();
      unbind();
    };
  },
});
