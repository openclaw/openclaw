import { expect, it, vi } from "vitest";
import {
  createClaudeCodeVersionRequirement,
  type ClaudeCodeVersionStore,
} from "./claude-code-version-requirement.js";

type Row = Awaited<ReturnType<ClaudeCodeVersionStore["lookup"]>>;

// One backing table shared by separate instances models plugin state across a process restart.
function requirement(rows: Map<string, Row>, installed?: string, openStore?: () => never) {
  return createClaudeCodeVersionRequirement({
    openStore:
      openStore ??
      (() => ({
        lookup: async (key) => rows.get(key),
        register: async (key, value) => rows.set(key, value),
      })),
    resolveInstalledVersion: async () => installed,
    warn: vi.fn(),
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("starts a restarted process at the version Anthropic last required", async () => {
  const rows = new Map<string, Row>();
  const first = requirement(rows);
  expect(await first.resolveVersion()).toBeUndefined();
  first.record("2.1.290");
  expect(await first.resolveVersion()).toBe("2.1.290");
  await settle();
  expect(await requirement(rows).resolveVersion()).toBe("2.1.290");
});

it("prefers the newer of the installed CLI and the stored requirement", async () => {
  const rows = new Map<string, Row>([["anthropic-oauth", { version: "2.1.290", learnedAt: 1 }]]);
  expect(await requirement(rows, "2.1.250").resolveVersion()).toBe("2.1.290");
  expect(await requirement(rows, "2.1.322").resolveVersion()).toBe("2.1.322");
});

it("keeps working when plugin state is unavailable", async () => {
  const closed = requirement(new Map(), "2.1.314", () => {
    throw new Error("state closed");
  });
  await expect(closed.resolveVersion()).resolves.toBe("2.1.314");
  closed.record("2.1.400");
  expect(await closed.resolveVersion()).toBe("2.1.400");
});
