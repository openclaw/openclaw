import {
  createMeetingPluginFixture,
  defineMeetingPluginSurfaceTests,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { TEAMS_MEETINGS_CLI_METADATA } from "./src/cli-output-mode.js";

const MEETING_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_owned%40thread.v2/0?context=%7b%7d";

const fixture = createMeetingPluginFixture({
  plugin,
  id: "teams-meetings",
  name: "Microsoft Teams meetings",
  url: MEETING_URL,
  title: "Teams",
  tabId: "teams-tab",
  methodPrefix: "teamsmeetings",
  toolName: "teams_meetings",
  nodeCommand: "teamsmeetings.chrome",
  descriptor: TEAMS_MEETINGS_CLI_METADATA.descriptor,
  transcriptSource: { id: "teams", aliases: ["teams-meetings", "microsoft-teams", "msteams"] },
});

describe("Microsoft Teams meetings plugin surface", () => {
  defineMeetingPluginSurfaceTests(fixture);

  it("accepts timeoutMs on testListen and reports a bounded caption timeout", async () => {
    const { invoke } = fixture.authorizationHarness();
    const response = await invoke("teamsmeetings.testListen", {
      mode: "transcribe",
      timeoutMs: 1,
      url: MEETING_URL,
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        captioning: undefined,
        createdSession: true,
        listenTimedOut: true,
        listenVerified: false,
      },
    });
  });
});
