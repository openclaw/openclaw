import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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

function accepted(events: RecorderEvent[], method: string, eventPath: string, type = "api") {
  return events.filter(
    (event) =>
      event.type === type &&
      event.method === method &&
      event.path === eventPath &&
      event.accepted === true,
  );
}
function outputDirectory(label: string) {
  return path.join(process.cwd(), ".artifacts", "qa-e2e", `${label}-${process.pid}-${Date.now()}`);
}
function runScenario(
  outputDir: string,
  id: string,
  mutateConfig?: Parameters<typeof runQaSuite>[0]["mutateConfig"],
) {
  return runQaSuite({
    channelDriver: "crabline",
    channelId: "discord",
    controlUiEnabled: false,
    outputDir,
    providerMode: "mock-openai",
    repoRoot: process.cwd(),
    scenarioIds: [id],
    ...(mutateConfig ? { mutateConfig } : {}),
    ...(id === SCENARIO_ID ? { primaryModel: "mock-openai/gpt-5.6-luna" } : {}),
  });
}
function recorderFile(outputDir: string) {
  return path.join(outputDir, "artifacts", "crabline", "discord-provider-server.jsonl");
}
async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

describe.runIf(RUN_DISCORD_CRABLINE_E2E)("Discord Crabline real-plugin roundtrip", () => {
  it("accepts top-level finals and rejects native reply finals through the shipped scenario", async () => {
    for (const forceReply of [false, true]) {
      const outputDir = outputDirectory("discord-final-shape");
      const suite = await runScenario(
        outputDir,
        "channel-top-level-reply-shape",
        forceReply
          ? (cfg) => ({
              ...cfg,
              channels: {
                ...cfg.channels,
                discord: { ...cfg.channels?.discord, replyToMode: "all" },
              },
            })
          : undefined,
      );
      expect(suite.result.scenarios).toEqual([
        expect.objectContaining({ status: forceReply ? "fail" : "pass" }),
      ]);
      if (forceReply) {
        expect(JSON.stringify(suite.result.scenarios)).toContain("expected top-level reply");
      }
      const events = await readRecorderEvents(recorderFile(outputDir));
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
  }, 360_000);

  it("crosses the real Discord REST and Gateway boundaries and closes every owned resource", async () => {
    const outputDir = outputDirectory(SCENARIO_ID);
    const suite = await runScenario(outputDir, SCENARIO_ID);

    expect(suite.executionKind).toBe("flow");
    expect(suite.result.scenarios).toEqual([
      expect.objectContaining({ name: expect.any(String), status: "pass" }),
    ]);

    const recorderPath = recorderFile(suite.result.outputDir);
    const events = await readRecorderEvents(recorderPath);
    expect(accepted(events, "GET", "/api/v10/gateway/bot")).not.toEqual([]);
    expect(accepted(events, "WS", "/gateway")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: expect.objectContaining({ op: 2 }) }),
      ]),
    );
    const inbound = accepted(events, "POST", "/crabline/discord/inbound", "admin")[0];
    const inboundBody = inbound?.body;
    const inboundChannelId = readStringValue(inboundBody?.channelId) ?? "";
    expect(inboundBody).toMatchObject({
      channelId: expect.stringMatching(/^\d{17,20}$/u),
      parentChannelId: expect.stringMatching(/^\d{17,20}$/u),
      content: expect.stringMatching(/<@\d{17,20}>/u),
    });
    expect(inboundChannelId).not.toBe(inboundBody?.parentChannelId);

    const isOutbound = (event: RecorderEvent) =>
      event.type === "api" &&
      event.method === "POST" &&
      event.path === `/api/v10/channels/${inboundChannelId}/messages` &&
      (readStringValue(event.body?.content) ?? "").includes(EXPECTED_MARKER) &&
      event.accepted === true;
    const outbound = events.find(isOutbound);
    expect(outbound).toMatchObject({
      body: {
        content: expect.stringContaining(EXPECTED_MARKER),
        message_reference: { message_id: expect.stringMatching(/^\d{17,20}$/u) },
      },
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

    const summary = (await readJson(path.join(outputDir, "qa-suite-summary.json"))) as {
      run?: { channelDriverSmokePath?: string };
    };
    const readinessPath = expectDefined(
      summary.run?.channelDriverSmokePath,
      "Discord Crabline readiness artifact path",
    );
    const readiness = (await readJson(path.resolve(outputDir, readinessPath))) as {
      providerReadiness?: { result?: { recorderPath?: string } };
    };
    const snapshotRecorderPath = expectDefined(
      readiness.providerReadiness?.result?.recorderPath,
      "Discord Crabline readiness snapshot recorder path",
    );
    const snapshotEvents = await readRecorderEvents(
      path.resolve(suite.result.outputDir, snapshotRecorderPath),
    );
    expect(path.resolve(suite.result.outputDir, snapshotRecorderPath)).not.toBe(recorderPath);
    expect(snapshotEvents.some((event) => event.accepted === true)).toBe(true);
    expect(snapshotEvents.some(isOutbound)).toBe(false);

    await expect(fs.readFile(recorderPath, "utf8")).resolves.toContain(EXPECTED_MARKER);
  }, 180_000);
});
