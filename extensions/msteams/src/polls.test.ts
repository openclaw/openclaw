import type { PluginRuntime } from "openclaw/plugin-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMSTeamsPollCard, createMSTeamsPollStoreFs, extractMSTeamsPollVote } from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";

const runtimeStub = {
  state: {
    resolveStateDir: (env: NodeJS.ProcessEnv = process.env, homedir?: () => string) => {
      const override = env.OPENCLAW_STATE_DIR?.trim() || env.OPENCLAW_STATE_DIR?.trim();
      if (override) {
        return override;
      }
      const resolvedHome = homedir ? homedir() : os.homedir();
      return path.join(resolvedHome, ".openclaw");
    },
  },
} as unknown as PluginRuntime;

describe("msteams polls", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
  });

  it("builds poll cards with fallback text", () => {
    const card = buildMSTeamsPollCard({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
    });

    expect(card.pollId).toBeTruthy();
    expect(card.fallbackText).toContain("Poll: Lunch?");
    expect(card.fallbackText).toContain("1. Pizza");
    expect(card.fallbackText).toContain("2. Sushi");
  });

  it("extracts poll votes from activity values", () => {
    const vote = extractMSTeamsPollVote({
      value: {
        openclawPollId: "poll-1",
        choices: "0,1",
      },
    });

    expect(vote).toEqual({
      pollId: "poll-1",
      selections: ["0", "1"],
    });
  });

  it("stores and records poll votes", async () => {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-polls-"));
    const store = createMSTeamsPollStoreFs({ homedir: () => home });
    await store.createPoll({
      id: "poll-2",
      question: "Pick one",
      options: ["A", "B"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });
    await store.recordVote({
      pollId: "poll-2",
      voterId: "user-1",
      selections: ["0", "1"],
    });
    const stored = await store.getPoll("poll-2");
    expect(stored?.votes["user-1"]).toEqual(["0"]);
  });
});
