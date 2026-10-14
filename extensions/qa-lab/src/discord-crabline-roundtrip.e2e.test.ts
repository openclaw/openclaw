import fs from "node:fs/promises";
import path from "node:path";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { runQaSuite } from "./suite-launch.runtime.js";

const RUN_DISCORD_CRABLINE_E2E = process.env.OPENCLAW_QA_DISCORD_CRABLINE_E2E === "1";
const SCENARIO_ID = "discord-crabline-roundtrip";
const EXPECTED_MARKER = "DISCORD-CRABLINE-ROUNDTRIP-OK";

type RecorderEvent = {
  accepted?: boolean;
  body?: Record<string, unknown>;
  method?: string;
  path?: string;
  type?: string;
};

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readRecorderEvents(recorderPath: string): Promise<RecorderEvent[]> {
  const raw = await fs.readFile(recorderPath, "utf8");
  if (/discord(?:app)?\.com|discordcdn\.com/u.test(raw)) {
    throw new Error("Discord Crabline recorder contains a public Discord service target");
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecorderEvent);
}

describe("Discord Crabline real-plugin roundtrip", () => {
  it.runIf(RUN_DISCORD_CRABLINE_E2E)(
    "accepts top-level finals and rejects native reply finals through the shipped scenario",
    async () => {
      for (const forceReply of [false, true]) {
        const outputDir = path.join(
          process.cwd(),
          ".artifacts",
          "qa-e2e",
          `discord-final-shape-${process.pid}-${Date.now()}`,
        );
        const suite = await runQaSuite({
          channelDriver: "crabline",
          channelId: "discord",
          controlUiEnabled: false,
          outputDir,
          providerMode: "mock-openai",
          repoRoot: process.cwd(),
          scenarioIds: ["channel-top-level-reply-shape"],
          ...(forceReply
            ? {
                mutateConfig: (cfg) => ({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    discord: { ...cfg.channels?.discord, replyToMode: "all" },
                  },
                }),
              }
            : {}),
        });
        expect(suite.result.scenarios).toEqual([
          expect.objectContaining({ status: forceReply ? "fail" : "pass" }),
        ]);
        if (forceReply) {
          expect(JSON.stringify(suite.result.scenarios)).toContain("expected top-level reply");
        }
        const events = await readRecorderEvents(
          path.join(outputDir, "artifacts", "crabline", "discord-provider-server.jsonl"),
        );
        const final = events.findLast(
          (event) =>
            event.type === "api" &&
            event.method === "POST" &&
            event.accepted === true &&
            event.body?.content === "QA-TOP-LEVEL-REPLY-OK",
        );
        expect(final).toBeDefined();
        expect(Boolean(readObject(final?.body?.message_reference)?.message_id)).toBe(forceReply);
      }
    },
    360_000,
  );

  it.runIf(RUN_DISCORD_CRABLINE_E2E)(
    "crosses the real Discord REST and Gateway boundaries and closes every owned resource",
    async () => {
      const repoRoot = process.cwd();
      const outputDir = path.join(
        repoRoot,
        ".artifacts",
        "qa-e2e",
        `discord-crabline-roundtrip-${process.pid}-${Date.now()}`,
      );
      const suite = await runQaSuite({
        channelDriver: "crabline",
        channelId: "discord",
        controlUiEnabled: false,
        outputDir,
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        repoRoot,
        scenarioIds: [SCENARIO_ID],
      });

      expect(suite.executionKind).toBe("flow");
      expect(suite.result.scenarios).toEqual([
        expect.objectContaining({ name: expect.any(String), status: "pass" }),
      ]);

      const recorderPath = path.join(
        suite.result.outputDir,
        "artifacts",
        "crabline",
        "discord-provider-server.jsonl",
      );
      const events = await readRecorderEvents(recorderPath);
      expect(
        events.find(
          (event) =>
            event.type === "api" &&
            event.method === "GET" &&
            event.path === "/api/v10/gateway/bot" &&
            event.accepted === true,
        ),
      ).toBeDefined();
      expect(
        events.find(
          (event) =>
            event.type === "api" &&
            event.method === "WS" &&
            event.path === "/gateway" &&
            readObject(event.body)?.op === 2 &&
            event.accepted === true,
        ),
      ).toBeDefined();

      const inbound = events.find(
        (event) =>
          event.type === "admin" &&
          event.method === "POST" &&
          event.path === "/crabline/discord/inbound" &&
          event.accepted === true,
      );
      const inboundBody = readObject(inbound?.body);
      const inboundChannelId = readStringValue(inboundBody?.channelId) ?? "";
      const parentChannelId = readStringValue(inboundBody?.parentChannelId) ?? "";
      expect(inboundChannelId).toMatch(/^\d{17,20}$/u);
      expect(parentChannelId).toMatch(/^\d{17,20}$/u);
      expect(inboundChannelId).not.toBe(parentChannelId);
      expect(readStringValue(inboundBody?.content) ?? "").toMatch(/<@\d{17,20}>/u);

      const outbound = events.find(
        (event) =>
          event.type === "api" &&
          event.method === "POST" &&
          event.path === `/api/v10/channels/${inboundChannelId}/messages` &&
          (readStringValue(readObject(event.body)?.content) ?? "").includes(EXPECTED_MARKER) &&
          event.accepted === true,
      );
      const outboundBody = readObject(outbound?.body);
      expect(outbound).toBeDefined();
      expect(readStringValue(outboundBody?.content) ?? "").toContain(EXPECTED_MARKER);
      expect(readObject(outboundBody?.message_reference)).toMatchObject({
        message_id: expect.stringMatching(/^\d{17,20}$/u),
      });

      expect(
        events.some(
          (event) =>
            event.type === "api" &&
            event.accepted === true &&
            (event.method === "PUT" || event.method === "POST") &&
            /^\/api\/v10\/applications\/\d{17,20}\/commands$/u.test(event.path ?? ""),
        ),
      ).toBe(true);

      const summary = JSON.parse(
        await fs.readFile(path.join(suite.result.outputDir, "qa-suite-summary.json"), "utf8"),
      ) as { run?: { channelDriverSmokePath?: string } };
      const readinessPath = summary.run?.channelDriverSmokePath;
      if (!readinessPath) {
        throw new Error("Discord Crabline readiness artifact path missing from QA summary");
      }
      const readiness = JSON.parse(
        await fs.readFile(path.resolve(suite.result.outputDir, readinessPath), "utf8"),
      ) as { providerReadiness?: { result?: { recorderPath?: string } } };
      const snapshotRecorderPath = readiness.providerReadiness?.result?.recorderPath;
      if (!snapshotRecorderPath) {
        throw new Error("Discord Crabline readiness snapshot recorder path missing");
      }
      const snapshotEvents = await readRecorderEvents(
        path.resolve(suite.result.outputDir, snapshotRecorderPath),
      );
      expect(path.resolve(suite.result.outputDir, snapshotRecorderPath)).not.toBe(recorderPath);
      expect(snapshotEvents.some((event) => event.accepted === true)).toBe(true);
      expect(
        snapshotEvents.some(
          (event) =>
            event.type === "api" &&
            event.method === "POST" &&
            event.path === `/api/v10/channels/${inboundChannelId}/messages` &&
            (readStringValue(readObject(event.body)?.content) ?? "").includes(EXPECTED_MARKER) &&
            event.accepted === true,
        ),
      ).toBe(false);

      // The suite returns only after Gateway, WebSocket, HTTP, recorder, and temporary runtime
      // owners have all completed their ordered cleanup.
      await expect(fs.readFile(recorderPath, "utf8")).resolves.toContain(EXPECTED_MARKER);
    },
    180_000,
  );
});
