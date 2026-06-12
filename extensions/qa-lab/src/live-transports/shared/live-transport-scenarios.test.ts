// Qa Lab tests cover live transport scenarios plugin behavior.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __testing as discordTesting } from "../discord/discord-live.runtime.js";
import { __testing as slackTesting } from "../slack/slack-live.runtime.js";
import { __testing as telegramTesting } from "../telegram/telegram-live.runtime.js";
import { __testing as whatsAppTesting } from "../whatsapp/whatsapp-live.runtime.js";
import {
  LIVE_TRANSPORT_BASELINE_REQUIREMENT_IDS,
  buildLiveTransportCoverageLaneSummaries,
  collectLiveTransportRequirementCoverage,
  findMissingLiveTransportRequirements,
  selectLiveTransportScenarios,
} from "./live-transport-scenarios.js";

describe("live transport scenario helpers", () => {
  it("uses the public live transport scenario SDK seam", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("./live-transport-scenarios.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("openclaw/plugin-sdk/qa-live-transport-scenarios");
    expect(source).not.toContain("openclaw/plugin-sdk/qa-runtime");
  });

  it("keeps the repo-wide baseline contract ordered", () => {
    expect(LIVE_TRANSPORT_BASELINE_REQUIREMENT_IDS).toEqual([
      "canary",
      "mention-gating",
      "allowlist-block",
      "top-level-reply-shape",
      "restart-resume",
    ]);
  });

  it("selects requested scenarios and reports unknown ids with the lane label", () => {
    const definitions = [
      { id: "alpha", timeoutMs: 1_000, title: "alpha" },
      { id: "beta", timeoutMs: 1_000, title: "beta" },
    ] as const;

    expect(
      selectLiveTransportScenarios({
        ids: ["beta"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toEqual([definitions[1]]);

    expect(() =>
      selectLiveTransportScenarios({
        ids: ["alpha", "missing"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toThrow("unknown Demo QA scenario id(s): missing");
  });

  it("dedupes always-on and scenario-backed requirement coverage", () => {
    const covered = collectLiveTransportRequirementCoverage({
      alwaysOnRequirementIds: ["canary"],
      scenarios: [
        {
          id: "scenario-1",
          requirementId: "mention-gating",
          timeoutMs: 1_000,
          title: "mention",
        },
        {
          id: "scenario-2",
          requirementId: "mention-gating",
          timeoutMs: 1_000,
          title: "mention again",
        },
        {
          id: "scenario-3",
          requirementId: "restart-resume",
          timeoutMs: 1_000,
          title: "restart",
        },
      ],
    });

    expect(covered).toEqual(["canary", "mention-gating", "restart-resume"]);
    expect(
      findMissingLiveTransportRequirements({
        coveredRequirementIds: covered,
        expectedRequirementIds: LIVE_TRANSPORT_BASELINE_REQUIREMENT_IDS,
      }),
    ).toEqual(["allowlist-block", "top-level-reply-shape"]);
  });

  it("summarizes live transport lane membership for coverage reports", () => {
    const lanes = buildLiveTransportCoverageLaneSummaries();

    expect(lanes.map((lane) => lane.transportId)).toEqual([
      "discord",
      "slack",
      "telegram",
      "whatsapp",
    ]);
    expect(lanes.find((lane) => lane.transportId === "telegram")?.members).toContainEqual({
      requirementId: "canary",
    });
    expect(lanes.find((lane) => lane.transportId === "slack")?.members).toContainEqual({
      requirementId: "thread-follow-up",
      scenarioId: "slack-thread-follow-up",
    });
    expect(lanes.find((lane) => lane.transportId === "whatsapp")?.members).toContainEqual({
      requirementId: "allowlist-block",
      scenarioId: "whatsapp-group-allowlist-block",
    });
    expect(
      lanes.find((lane) => lane.transportId === "discord")?.baselineMissingRequirementIds,
    ).toEqual(["allowlist-block", "top-level-reply-shape", "restart-resume"]);
    expect(
      lanes.find((lane) => lane.transportId === "whatsapp")?.baselineMissingRequirementIds,
    ).toEqual([]);
  });

  it("keeps coverage report lane summaries aligned with runtime lanes", () => {
    const lanes = new Map(
      buildLiveTransportCoverageLaneSummaries().map((lane) => [
        lane.transportId,
        lane.requirementIds,
      ]),
    );

    expect(lanes.get("discord")).toEqual(discordTesting.DISCORD_QA_REQUIREMENT_IDS);
    expect(lanes.get("slack")).toEqual(slackTesting.SLACK_QA_REQUIREMENT_IDS);
    expect(lanes.get("telegram")).toEqual(telegramTesting.TELEGRAM_QA_REQUIREMENT_IDS);
    expect(lanes.get("whatsapp")).toEqual(whatsAppTesting.WHATSAPP_QA_REQUIREMENT_IDS);
  });
});
