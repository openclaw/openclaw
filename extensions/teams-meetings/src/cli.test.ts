import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCliMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  const adapter = original.MeetingPlatformAdapter;
  const defineBrowserMeetingPlugin: typeof adapter.defineBrowserMeetingPlugin = (spec) =>
    adapter.defineBrowserMeetingPlugin({
      ...spec,
      cli: { ...spec.cli, callGateway: callGatewayFromCliMock },
    });
  return {
    ...original,
    MeetingPlatformAdapter: { ...adapter, defineBrowserMeetingPlugin },
  };
});

import { teamsMeetingsPlugin } from "../index.js";

const resolveTeamsMeetingsConfig = teamsMeetingsPlugin.config.resolveConfig;

const MEETING_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_cli_probe%40thread.v2/0";

afterEach(() => {
  callGatewayFromCliMock.mockReset();
  vi.restoreAllMocks();
});

describe("Microsoft Teams meetings CLI", () => {
  it("forwards the listening probe timeout to the gateway operation", async () => {
    callGatewayFromCliMock.mockResolvedValue({ ok: true });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = new Command();
    (await teamsMeetingsPlugin.loadCli())({ program, config: resolveTeamsMeetingsConfig({}) });
    await program.parseAsync(
      ["teamsmeetings", "test-listen", MEETING_URL, "--timeout-ms", "90000"],
      { from: "user" },
    );

    expect(callGatewayFromCliMock).toHaveBeenCalledWith(
      "teamsmeetings.testListen",
      { json: true, timeout: "120000" },
      { url: MEETING_URL, timeoutMs: 90_000 },
      { progress: false, scopes: ["operator.admin"] },
    );
  });
});
