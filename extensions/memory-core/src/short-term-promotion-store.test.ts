import { describe, expect, it } from "vitest";
import {
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { readPhaseSignalStore } from "./short-term-promotion-store.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

describe("phase-signal store string fields", () => {
  const { createTempWorkspace } = createMemoryCoreTestHarness();
  const nowIso = "2026-04-05T10:00:00.000Z";
  const padded = ` ${nowIso} `;

  it.each([
    {
      label: "padded strings",
      value: padded,
      key: padded,
      updatedAt: padded,
      timestamps: { lastLightAt: padded, lastRemAt: padded, lastRemConsideredAt: padded },
    },
    { label: "blank strings", value: " \t ", key: "row", updatedAt: nowIso, timestamps: {} },
    { label: "non-strings", value: 17, key: "row", updatedAt: nowIso, timestamps: {} },
  ])("preserves the read contract for $label", async ({ value, key, updatedAt, timestamps }) => {
    const workspaceDir = await createTempWorkspace("phase-fields-");
    await writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir,
      entries: [
        {
          key: "row",
          value: {
            key: value,
            lightHits: 1,
            remHits: 2,
            lastLightAt: value,
            lastRemAt: value,
            lastRemConsideredAt: value,
          },
        },
      ],
    });
    await writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
      key: "phase",
      value: { updatedAt: value },
    });

    expect(await readPhaseSignalStore(workspaceDir, nowIso)).toEqual({
      version: 1,
      updatedAt,
      entries: { [key]: { key, lightHits: 1, remHits: 2, ...timestamps } },
    });
  });
});
