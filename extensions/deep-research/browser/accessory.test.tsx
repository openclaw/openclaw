/* @vitest-environment jsdom */
// The session-header accessory must stay out of idle conversations.
import { render } from "@solidjs/web";
import { describe, expect, it } from "vitest";
import { ResearchAccessory } from "./index.js";

function stubClient(snapshot: unknown) {
  return {
    read: () => snapshot,
    subscribe: () => () => {},
    refresh: () => undefined,
  } as unknown as Parameters<typeof ResearchAccessory>[0]["client"];
}

function mountAccessory(snapshot: unknown) {
  const container = document.createElement("div");
  render(() => <ResearchAccessory client={stubClient(snapshot)} open={() => {}} />, container);
  return container;
}

describe("ResearchAccessory", () => {
  it("renders no chrome while the session has no research job", () => {
    const container = mountAccessory({ offline: false, job: null });

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("still reports an active job and an offline client", () => {
    const running = mountAccessory({
      offline: false,
      job: { phase: "searching", counts: { sources: 2 } },
    });
    expect(
      running.querySelector("button.cn-deep-research-accessory, button.deep-research-accessory"),
    ).not.toBeNull();
    expect(running.textContent).toContain("Research · searching");
    expect(running.textContent).toContain("2 sources");

    const offline = mountAccessory({ offline: true, job: null });
    expect(offline.textContent).toBe("Research · offline");
  });
});
