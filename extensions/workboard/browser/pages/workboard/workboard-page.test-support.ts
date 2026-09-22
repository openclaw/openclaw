import "../../test/dom.setup.ts";
import { afterEach, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { createWorkboardPage } from "./workboard-page.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  document.body.replaceChildren();
});

export function mountPage(
  params: { boardId?: string; connected?: boolean; presented?: boolean } = {},
) {
  const fixture = workboardTestHost();
  const workboard = createWorkboardCapability();
  fixture.connection.connected = params.connected ?? false;
  Object.assign(fixture.host.agents, { rows: [], defaultId: null });
  let agents: AgentsListResult["agents"] = [{ id: "main" }, { id: "writer" }];
  let cards = [createWorkboardCard({ title: "Initial card" })];
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "agents.list") {
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [...agents],
      };
    }
    if (method === "workboard.cards.list") {
      return { cards };
    }
    if (method === "tasks.list") {
      return { tasks: [] };
    }
    return {};
  });
  fixture.host.request = request as typeof fixture.host.request;
  fixture.host.agents.refresh = vi.fn(async () => {
    const result = await fixture.host.request<AgentsListResult>("agents.list", {});
    Object.assign(fixture.host.agents, { rows: result.agents, defaultId: result.defaultId });
    fixture.notify();
  });
  const container = document.createElement("div");
  document.body.append(container);
  let context = createViewContext<Readonly<Record<string, string>>>(
    fixture.host,
    params.boardId ? { boardId: params.boardId } : {},
    params.presented ?? true,
  );
  const mounted = createWorkboardPage(workboard)(container, context);
  cleanup.push(() => {
    mounted?.dispose?.();
    workboard.dispose();
  });
  return {
    fixture,
    workboard,
    container,
    request,
    cards(next: typeof cards) {
      cards = next;
    },
    agents(next: typeof agents) {
      agents = next;
    },
    navigate(boardId: string) {
      context = { ...context, props: { boardId } };
      mounted?.update?.(context);
    },
    present(presented: boolean) {
      context = { ...context, presented };
      mounted?.update?.(context);
    },
    dispose() {
      mounted?.dispose?.();
    },
  };
}
