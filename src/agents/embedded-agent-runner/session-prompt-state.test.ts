import { beforeEach, describe, expect, it } from "vitest";
import {
  getEmbeddedSessionPromptState,
  markEmbeddedSessionToolAccessPolicySnapshotRequired,
  markToolAccessPolicySnapshotSent,
  reserveToolAccessPolicySnapshot,
  shouldEmitToolAccessPolicySnapshot,
  testing,
} from "./session-prompt-state.js";

describe("embedded session tool-access policy prompt state", () => {
  beforeEach(() => testing.reset());

  it("emits once for an unchanged policy and continuation route", () => {
    const state = getEmbeddedSessionPromptState("session-1").toolAccessPolicy;

    expect(
      shouldEmitToolAccessPolicySnapshot(state, {
        policyVersion: "tap-a",
        routeKey: "openclaw:openai:gpt-5.6-sol",
      }),
    ).toBe(true);

    markToolAccessPolicySnapshotSent(state, {
      policyVersion: "tap-a",
      routeKey: "openclaw:openai:gpt-5.6-sol",
      snapshotGeneration: reserveToolAccessPolicySnapshot(state),
    });

    expect(
      shouldEmitToolAccessPolicySnapshot(state, {
        policyVersion: "tap-a",
        routeKey: "openclaw:openai:gpt-5.6-sol",
      }),
    ).toBe(false);
  });

  it("resends for policy, route, explicit rebuild, and compaction changes", () => {
    const state = getEmbeddedSessionPromptState("session-2").toolAccessPolicy;
    markToolAccessPolicySnapshotSent(state, {
      policyVersion: "tap-a",
      routeKey: "openclaw:openai:gpt-5.6-sol",
      snapshotGeneration: reserveToolAccessPolicySnapshot(state),
    });

    expect(
      shouldEmitToolAccessPolicySnapshot(state, {
        policyVersion: "tap-b",
        routeKey: "openclaw:openai:gpt-5.6-sol",
      }),
    ).toBe(true);
    expect(
      shouldEmitToolAccessPolicySnapshot(state, {
        policyVersion: "tap-a",
        routeKey: "codex:openai:gpt-5.6-sol",
      }),
    ).toBe(true);
    expect(
      shouldEmitToolAccessPolicySnapshot(state, {
        policyVersion: "tap-a",
        routeKey: "openclaw:openai:gpt-5.6-sol",
        forceSnapshot: true,
      }),
    ).toBe(true);

    markEmbeddedSessionToolAccessPolicySnapshotRequired(["session-2"]);
    expect(
      shouldEmitToolAccessPolicySnapshot(state, {
        policyVersion: "tap-a",
        routeKey: "openclaw:openai:gpt-5.6-sol",
      }),
    ).toBe(true);
  });

  it("requires a full snapshot after process-local reconstruction", () => {
    const beforeReset = getEmbeddedSessionPromptState("session-3").toolAccessPolicy;
    markToolAccessPolicySnapshotSent(beforeReset, {
      policyVersion: "tap-a",
      routeKey: "openclaw:openai:gpt-5.6-sol",
      snapshotGeneration: reserveToolAccessPolicySnapshot(beforeReset),
    });
    testing.reset();

    const reconstructed = getEmbeddedSessionPromptState("session-3").toolAccessPolicy;
    expect(
      shouldEmitToolAccessPolicySnapshot(reconstructed, {
        policyVersion: "tap-a",
        routeKey: "openclaw:openai:gpt-5.6-sol",
      }),
    ).toBe(true);
  });

  it("ignores stale acknowledgements after a newer snapshot or rebuild", () => {
    const state = getEmbeddedSessionPromptState("session-4").toolAccessPolicy;
    const firstGeneration = reserveToolAccessPolicySnapshot(state);
    const secondGeneration = reserveToolAccessPolicySnapshot(state);

    expect(
      markToolAccessPolicySnapshotSent(state, {
        policyVersion: "tap-a",
        routeKey: "openclaw:openai:gpt-5.6-sol",
        snapshotGeneration: firstGeneration,
      }),
    ).toBe(false);
    expect(
      markToolAccessPolicySnapshotSent(state, {
        policyVersion: "tap-b",
        routeKey: "openclaw:openai:gpt-5.6-sol",
        snapshotGeneration: secondGeneration,
      }),
    ).toBe(true);

    const generationBeforeRebuild = reserveToolAccessPolicySnapshot(state);
    markEmbeddedSessionToolAccessPolicySnapshotRequired(["session-4"]);
    expect(
      markToolAccessPolicySnapshotSent(state, {
        policyVersion: "tap-b",
        routeKey: "openclaw:openai:gpt-5.6-sol",
        snapshotGeneration: generationBeforeRebuild,
      }),
    ).toBe(false);
    expect(state.forceSnapshot).toBe(true);
  });
});
