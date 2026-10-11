import { describe, expect, it, vi } from "vitest";
import { runCommand, useCodexCommandTestState } from "./commands.test-support.js";

// `/codex sessions --host <node>` output: per-row partial-scan marks and the truncation notices that
// tell a bounded listing apart from a complete one. The node answer is supplied directly so each
// case pins one rendering; the node-side scan that produces it is covered in
// `node-cli-session-files.test.ts`.
describe("codex command: CLI sessions listing", () => {
  useCodexCommandTestState({ onSetup: () => {} });

  it("marks Codex CLI sessions whose preview came from a windowed read", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        sessions: [
          {
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
            updatedAt: "2026-05-13T06:30:00.000Z",
            lastMessage: "fix the bridge",
            messageCount: 2,
            partialScan: true,
          },
          {
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5ce",
            cwd: "/repo",
            updatedAt: "2026-05-13T06:20:00.000Z",
            lastMessage: "read the whole thing",
            messageCount: 4,
          },
        ],
      },
    }));

    const result = await runCommand("sessions --host mb-m5", { listCodexCliSessionsOnNode });

    expect(result.text).toContain("fix the bridge (/repo, 2026-05-13T06:30:00.000Z, partial scan)");
    expect(result.text).toContain("read the whole thing (/repo, 2026-05-13T06:20:00.000Z)");
  });

  it("says so when a filtered Codex CLI session search stopped short of the whole codex-home", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        scannedFileCount: 220,
        sessionFileCount: 2928,
        searchTruncated: true,
        sessions: [
          {
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
            updatedAt: "2026-05-13T06:30:00.000Z",
            lastMessage: "fix the bridge",
            messageCount: 2,
          },
        ],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 bridge", { listCodexCliSessionsOnNode });

    expect(result.text).toContain("Searched 220 of 2928 rollouts");
    expect(result.text).toContain("019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd");
  });

  it("still says a Codex CLI session search was cut when it matched nothing", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        scannedFileCount: 342,
        sessionFileCount: 2928,
        searchTruncated: true,
        sessions: [],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 /repo", { listCodexCliSessionsOnNode });

    // An empty answer to a cut search is the one a caller is most likely to read as "no such
    // session exists", so the notice has to reach this path and not just the non-empty one.
    expect(result.text).toContain("No Codex CLI sessions returned");
    expect(result.text).toContain("Searched 342 of 2928 rollouts");
  });

  it("says a Codex CLI search covering every rollout still left content unread", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        scannedFileCount: 12,
        sessionFileCount: 12,
        searchTruncated: true,
        unreadSpanCount: 2,
        sessions: [],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 /repo", { listCodexCliSessionsOnNode });

    // Every file was opened, so there is no "N of M" clause to print — but two of them were only
    // windowed, and saying nothing would present that as an exhaustive "no such session".
    expect(result.text).toContain("No Codex CLI sessions returned");
    expect(result.text).toContain("2 rollouts were too large to read whole");
    expect(result.text).not.toContain("Searched 12 of 12");
  });

  it("keeps the truncation notice unquantified when the node reported no rollout counts", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        searchTruncated: true,
        sessions: [],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 /repo", { listCodexCliSessionsOnNode });

    // A node build without the counters must not be rendered as "Searched 0 of 0 rollouts".
    expect(result.text).toContain("Only part of this codex-home was searched");
    expect(result.text).not.toContain("0 of 0");
  });

  it("leaves an empty Codex CLI session result unqualified when the search was complete", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        scannedFileCount: 12,
        sessionFileCount: 12,
        sessions: [],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 /repo", { listCodexCliSessionsOnNode });

    expect(result.text).toContain("No Codex CLI sessions returned");
    expect(result.text).not.toContain("Searched");
  });

  it("leaves a complete Codex CLI session search unqualified", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        scannedFileCount: 12,
        sessionFileCount: 12,
        sessions: [
          {
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
            updatedAt: "2026-05-13T06:30:00.000Z",
            lastMessage: "fix the bridge",
            messageCount: 2,
          },
        ],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 bridge", { listCodexCliSessionsOnNode });

    expect(result.text).not.toContain("Searched");
  });

  it("offers the complete search when a Codex CLI search left rollouts unopened", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        scannedFileCount: 2000,
        sessionFileCount: 2928,
        searchTruncated: true,
        sessions: [],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 /repo", { listCodexCliSessionsOnNode });

    // Naming the rerun is what keeps a bounded scan from reading as a permanent loss: the 928
    // rollouts this one never opened are still reachable, and the notice has to say how.
    expect(result.text).toContain("Searched 2000 of 2928 rollouts");
    expect(result.text).toContain(
      "Add --search-all to read every rollout on this node in full instead.",
    );
  });

  it("offers the complete search when an opened rollout went partly unread", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        scannedFileCount: 12,
        sessionFileCount: 12,
        searchTruncated: true,
        unreadSpanCount: 2,
        sessions: [],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 /repo", { listCodexCliSessionsOnNode });

    // Every file was opened, so there is no "N of M" clause — but two of them were only windowed,
    // and the complete search clears that cause too by reading each rollout whole. Suppressing the
    // offer here would strand the one rerun that can still answer the question.
    expect(result.text).toContain("2 rollouts were too large to read whole");
    expect(result.text).not.toContain("Searched 12 of 12");
    expect(result.text).toContain(
      "Add --search-all to read every rollout on this node in full instead.",
    );
  });
});
