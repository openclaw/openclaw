/** @jsxImportSource @solidjs/web */

/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { flush } from "../../../../ui/src/test-helpers/solid-settle.ts";
import { ChatPullRequestChecks } from "../chat-pull-request-checks.tsx";
import { mountRepositorySolid as mountSolid } from "./repository-ci.test-support.tsx";

it("keeps native disclosure intent through parking and clears it on dismissal", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  let update!: (next: { presented: boolean; dismissed: boolean }) => void;
  const mounted = mountSolid(
    () => {
      const [state, setState] = createSignal({ presented: true, dismissed: false });
      update = setState;
      return (
        <ChatPullRequestChecks
          label="Checks passed"
          checksState="passing"
          presented={state().presented}
          dismissed={state().dismissed}
        >
          {() => "All checks passed"}
        </ChatPullRequestChecks>
      );
    },
    { container },
  );
  try {
    flush();
    const disclosure = container.querySelector<HTMLDetailsElement>("details")!;
    const surface = container.querySelector<HTMLElement>("[popover]")!;
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    expect(surface.matches(":popover-open")).toBe(true);
    update({ presented: false, dismissed: false });
    flush();
    expect(disclosure.open).toBe(true);
    expect(surface.matches(":popover-open")).toBe(false);
    update({ presented: true, dismissed: false });
    flush();
    expect(surface.matches(":popover-open")).toBe(true);
    expect(container.querySelector("details")).toBe(disclosure);
    update({ presented: false, dismissed: true });
    flush();
    expect(disclosure.open).toBe(false);
    expect(surface.matches(":popover-open")).toBe(false);
    update({ presented: true, dismissed: false });
    flush();
    expect(disclosure.open).toBe(false);
    expect(surface.matches(":popover-open")).toBe(false);
    expect(
      warnings.mock.calls.filter(([text]) => String(text).includes("STRICT_READ_UNTRACKED")),
    ).toEqual([]);
  } finally {
    mounted.unmount();
    container.remove();
    warnings.mockRestore();
  }
});
