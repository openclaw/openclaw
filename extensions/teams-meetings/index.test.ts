import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import {
  createMeetingPluginFixture,
  defineMeetingPluginSurfaceTests,
  useMeetingTestState,
} from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEAMS_MEETINGS_CLI_METADATA } from "./cli-metadata.js";
import plugin, { teamsMeetingsPlugin } from "./index.js";

const MEETING_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_owned%40thread.v2/0?context=%7b%7d";

const fixture = createMeetingPluginFixture({
  testState: useMeetingTestState(createOpenClawTestState),
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
  afterEach(() => vi.restoreAllMocks());
  defineMeetingPluginSurfaceTests(fixture);

  it("holds concurrent source calls until the current transcript policy is ready", async () => {
    const firstPolicy = createDeferred<void>();
    const nextPolicy = createDeferred<void>();
    const initializing = createDeferred<void>();
    const runtime = teamsMeetingsPlugin.Runtime.prototype as InstanceType<
      typeof teamsMeetingsPlugin.Runtime
    >;
    const reconcile = vi
      .spyOn(runtime, "reconcileTranscriptPolicy")
      .mockImplementationOnce(async () => {
        initializing.resolve();
        await firstPolicy.promise;
      })
      .mockImplementationOnce(() => nextPolicy.promise);
    const stop = vi
      .spyOn(runtime, "stopTranscriptSource")
      .mockImplementation(async ({ sessionId }) => ({
        ok: true,
        sessionId,
      }));
    const services: OpenClawPluginService[] = [];
    const api = fixture.createApi({
      registerService(service) {
        if (service.apiVersion === undefined || service.apiVersion === 1) {
          services.push(service);
        }
      },
    });
    const providers = vi.spyOn(api, "registerTranscriptSourceProvider");
    plugin.register(api);
    const service = services[0];
    const stopSource = providers.mock.calls[0]?.[0].stop;
    assert.ok(service?.stop && stopSource);
    const context = { config: {}, stateDir: "unused", logger: api.logger };
    const request = { sessionId: "captions", source: { providerId: "teams" } };
    await service.stop(context);
    expect(reconcile).not.toHaveBeenCalled();
    const first = stopSource(request);
    await initializing.promise;
    const second = stopSource(request);
    const restarting = service.start(context);
    firstPolicy.resolve();
    await setImmediate();
    const dispatchedBeforeReload = stop.mock.calls.length;
    nextPolicy.resolve();
    await Promise.all([first, second, restarting]);
    expect(reconcile.mock.calls).toEqual([[false], [true]]);
    expect(dispatchedBeforeReload).toBe(0);
    expect(stop).toHaveBeenCalledTimes(2);
  });

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
