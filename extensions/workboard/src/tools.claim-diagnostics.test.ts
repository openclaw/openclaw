// Workboard tests cover claim rejection diagnostics through registered tools.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function createTools() {
  const store = createWorkboardSqliteTestStore();
  const tools = new Map(
    createWorkboardTools({ store, context: { agentId: "main" } }).map((tool) => [tool.name, tool]),
  );
  return { store, tools };
}

describe("workboard claim diagnostics through registered tools", () => {
  it("names the unfinished parent and its status when workboard_claim is rejected", async () => {
    const { tools } = createTools();

    const parent = readPayload(
      await expectDefined(tools.get("workboard_create"), "workboard_create").execute("call-1", {
        title: "Parent A",
        status: "ready",
      }),
    ).card as { id: string; status: string };

    const child = readPayload(
      await expectDefined(tools.get("workboard_create"), "workboard_create").execute("call-2", {
        title: "Child B",
        parents: [parent.id],
      }),
    ).card as { id: string; status: string };
    expect(child.status).toBe("todo");

    // Parent A is deliberately left not done, so claiming child B must name it.
    await expect(
      expectDefined(tools.get("workboard_claim"), "workboard_claim").execute("call-3", {
        id: child.id,
      }),
    ).rejects.toThrow(`card dependencies are not done: ${parent.id} is ready.`);
  });

  it("reports the schedule rather than an empty dependency list once every parent is done", async () => {
    const { store, tools } = createTools();
    const scheduledAt = Date.now() + 60 * 60_000;

    const parent = readPayload(
      await expectDefined(tools.get("workboard_create"), "workboard_create").execute("call-1", {
        title: "Parent A",
        status: "done",
      }),
    ).card as { id: string };

    const child = readPayload(
      await expectDefined(tools.get("workboard_create"), "workboard_create").execute("call-2", {
        title: "Child B",
        parents: [parent.id],
      }),
    ).card as { id: string };
    await store.update(child.id, { status: "scheduled", scheduledAt });

    // Every parent is done, so the dependency error would have rendered an empty
    // list; the card is held by its own future schedule instead.
    const error = await expectDefined(tools.get("workboard_claim"), "workboard_claim")
      .execute("call-3", { id: child.id })
      .then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
    expect(error?.message).toBe(
      `card is scheduled for ${new Date(scheduledAt).toISOString()}; claim after that time.`,
    );
    expect(error?.message).not.toContain("dependencies are not done");
  });
});
