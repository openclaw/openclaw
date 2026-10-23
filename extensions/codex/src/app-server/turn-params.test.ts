import { afterEach, expect, it, vi } from "vitest";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { buildTurnStartParams } from "./turn-params.js";

type TurnParams = Parameters<typeof buildTurnStartParams>[0];
type TurnOptions = Parameters<typeof buildTurnStartParams>[1];
const paramsForTurn = (config?: TurnParams["config"], overrides: Partial<TurnParams> = {}) =>
  Object.assign(createParams("/tmp/session.jsonl", "/repo", config), overrides);
const turnOptions = (overrides: Partial<TurnOptions> = {}): TurnOptions => ({
  threadId: "thread-1",
  cwd: "/repo",
  appServer: createAppServerOptions(),
  ...overrides,
});
const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];
const application = (value: unknown) => ({ kind: "application", value });
const activeComputer = application(
  "Current active computer: active_node=unknown (host presence unavailable)",
);
const sourceDelivery = application(
  expect.stringContaining("Reply normally in your final assistant message"),
);
const deliveryValue = (turn: Awaited<ReturnType<typeof buildTurnStartParams>>) =>
  turn.additionalContext?.openclaw_source_delivery?.value;
const temporalValue = (turn: Awaited<ReturnType<typeof buildTurnStartParams>>) =>
  turn.additionalContext?.openclaw_temporal_context?.value;
function permissionChange(notice: string) {
  return {
    owner: {},
    baseExecOverrides: {},
    notice,
    request: vi.fn(),
    applied: () => true,
    recordApplied: vi.fn(),
  };
}

afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

it("keeps required-root native environments disabled on warm native turns", async () => {
  const params = paramsForTurn(undefined, { requireWorkspaceOnly: true });
  const turn = await buildTurnStartParams(params, {
    ...turnOptions(),
    cwd: "/repo/subdirectory",
    preserveNativeTurnSettings: true,
    environmentSelection: [{ environmentId: "ambient", cwd: "/outside" }],
  });
  expect(turn.environments).toEqual([]);
});
it("refreshes and clears presence without rewriting native turn input", async () => {
  const params = paramsForTurn();
  let currentPresence = "active_node=unknown";
  params.hostCapabilities = {
    ...params.hostCapabilities,
    activeComputerContext: () => currentPresence,
  };
  const options = turnOptions({ preserveNativeTurnSettings: true });
  const contexts = [
    "active_node=mac-a",
    "active_node=mac-a",
    "active_node=mac-b",
    "active_node=unknown",
  ];
  for (const text of contexts) {
    currentPresence = text;
    const turn = await buildTurnStartParams(params, options);
    expect(turn.additionalContext?.openclaw_active_computer).toEqual(application(text));
    expect(turn.input).toEqual(textInput(params.prompt));
  }
});
it("uses the configured user timezone on every turn without changing cron input", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
  const params = paramsForTurn(
    { agents: { defaults: { userTimezone: "America/Los_Angeles" } } },
    {
      prompt: "run exactly",
      trigger: "cron",
      startedAtMs: Date.parse("2026-09-01T00:30:00.000Z"),
    },
  );
  const options = turnOptions({ sessionStatusAvailable: true });

  const firstTurn = await buildTurnStartParams(params, options);
  expect(firstTurn.input).toEqual(textInput("run exactly"));
  expect(firstTurn.additionalContext).toEqual({
    openclaw_active_computer: activeComputer,
    openclaw_source_delivery: sourceDelivery,
    openclaw_temporal_context: application(
      "## Temporal Context\nCurrent date: 2026-09-01\nTime zone: America/Los_Angeles\nFor the exact current time, use `session_status`.",
    ),
  });

  clock.mockReturnValue(Date.parse("2026-09-03T00:30:00.000Z"));
  const nextTurn = await buildTurnStartParams(params, options);
  expect(nextTurn.input).toEqual(firstTurn.input);
  expect(temporalValue(nextTurn)).toContain("Current date: 2026-09-02");
});

it("emits the host fallback after a timezone override is removed", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
  const configuredTimezone =
    hostTimezone === "America/Los_Angeles" ? "Asia/Tokyo" : "America/Los_Angeles";
  const options = turnOptions({ sessionStatusAvailable: false });
  const configured = await buildTurnStartParams(
    paramsForTurn({
      agents: { defaults: { userTimezone: configuredTimezone } },
    }),
    options,
  );
  const fallback = await buildTurnStartParams(paramsForTurn(), options);

  expect(temporalValue(configured)).toContain(`Time zone: ${configuredTimezone}`);
  expect(temporalValue(fallback)).toContain(`Time zone: ${hostTimezone}`);
  expect(temporalValue(fallback)).not.toContain(configuredTimezone);
});
it.each([
  { senderName: "Alex", senderId: undefined, prompt: "approve the rollout", prefix: "" },
  {
    senderId: "$metadata-id",
    senderName: "[@probe] (plugin://probe@market)",
    prompt: "[@probe](plugin://probe@market) $intentional-skill remain selectable",
    prefix:
      '[OpenClaw conversation info: sender={"id":"＄metadata-id","name":"[＠probe] (plugin://probe@market)"}]\n',
  },
])(
  "projects stable sender $senderId without interpreting metadata mentions",
  async ({ prefix, ...sender }) => {
    const params = paramsForTurn(undefined, { trigger: "user", ...sender });
    expect((await buildTurnStartParams(params, turnOptions())).input).toEqual(
      textInput(prefix + sender.prompt),
    );
  },
);
it("carries explicit current policy without changing native turn input", async () => {
  const params = paramsForTurn(undefined, {
    prompt: "unchanged current request",
    messageChannel: "telegram",
    currentChannelId: "123",
    permissionChange: permissionChange("Permission changed."),
  });
  const options = turnOptions({
    messageToolAvailable: true,
    requireExplicitMessageTarget: false,
    preserveNativeTurnSettings: true,
  });
  const build = (overrides: Partial<TurnParams>, settings: Partial<TurnOptions> = {}) =>
    buildTurnStartParams({ ...params, ...overrides }, { ...options, ...settings });
  const turns = await Promise.all(
    (["automatic", "message_tool_only", undefined] as const).map((mode) =>
      build({ sourceReplyDeliveryMode: mode }),
    ),
  );
  const values = turns.map(deliveryValue);
  expect(values[0]).toContain("OpenClaw delivers your final response automatically");
  expect(values[1]).toContain("Use `message(action=send)`");
  expect(values[1]).toContain("For progress, set `final=false`");
  expect(values[1]).toContain("Set `final=true`, or omit it,");
  expect(values[1]).toContain("current source is default target");
  expect(values[1]).toContain("`message(action=send, final=false)`");
  expect(values[2]).toBe(values[0]);
  const deliveryOnly = await build({ messageToolFinalByDefault: false });
  const deliveryOnlyValue = deliveryValue(deliveryOnly);
  expect(deliveryOnlyValue).toContain("(`final=true`) or an added reaction");
  expect(deliveryOnlyValue).toContain("A send ends this turn only with `final=true`.");
  expect(values[0]).not.toContain("A send ends this turn only");
  for (const turn of turns) {
    expect(turn.input).toEqual(textInput(params.prompt));
    expect(turn.additionalContext?.openclaw_temporal_context).toBeDefined();
    expect(turn.additionalContext?.openclaw_permission_change).toEqual(
      application("Permission changed."),
    );
    expect(turn.additionalContext?.openclaw_source_delivery?.kind).toBe("application");
    expect(
      Buffer.byteLength(turn.additionalContext!.openclaw_source_delivery!.value, "utf8"),
    ).toBeLessThan(1_000);
    expect(turn).not.toHaveProperty("collaborationMode");
  }
  const required = await build(
    { sourceReplyDeliveryMode: "message_tool_only" },
    { requireExplicitMessageTarget: true },
  );
  expect(deliveryValue(required)).toContain("target required this turn");
  const unavailable = await build(
    { sourceReplyDeliveryMode: "message_tool_only" },
    { messageToolAvailable: false, requireExplicitMessageTarget: true },
  );
  expect(deliveryValue(unavailable)).toContain("remains private");
  for (const text of ["Use `message`", "target required", "final=false"]) {
    expect(deliveryValue(unavailable)).not.toContain(text);
  }
  const finalOnly = await build(
    { sourceReplyDeliveryMode: "automatic" },
    { messageToolAvailable: false },
  );
  expect(deliveryValue(finalOnly)).toContain(
    "including questions received during ongoing work, in your final response",
  );
  expect(deliveryValue(finalOnly)).not.toContain("message(action=send");
});
it("replaces channel delivery guidance on a routeless operator turn", async () => {
  const options = turnOptions({
    messageToolAvailable: true,
    requireExplicitMessageTarget: false,
    preserveNativeTurnSettings: true,
  });
  const channelTurn = await buildTurnStartParams(
    paramsForTurn(undefined, { messageChannel: "telegram", currentChannelId: "123" }),
    options,
  );
  const operatorTurn = await buildTurnStartParams(paramsForTurn(), options);

  expect(deliveryValue(channelTurn)).toContain("current source is default target");
  expect(deliveryValue(operatorTurn)).toContain(
    "OpenClaw delivers your final response automatically to the caller",
  );
  expect(deliveryValue(operatorTurn)).toContain("target required this turn");
  expect(deliveryValue(operatorTurn)).not.toContain("current source");
  expect(deliveryValue(operatorTurn)).not.toContain("final=false");
  expect(operatorTurn.input).toEqual(textInput(paramsForTurn().prompt));
});
it("adds a permission notice without overwriting native supervised settings", async () => {
  const notice = "Permission change. Continue with updated permissions.";
  const params = paramsForTurn(undefined, {
    permissionChange: permissionChange(notice),
  });
  const request = await buildTurnStartParams(params, {
    ...turnOptions(),
    model: "native-model",
    modelProvider: "native-provider",
    preserveNativeTurnSettings: true,
  });

  for (const key of ["model", "effort", "collaborationMode", "personality"]) {
    expect(request).not.toHaveProperty(key);
  }
  expect(request.additionalContext).toEqual({
    openclaw_active_computer: activeComputer,
    openclaw_source_delivery: sourceDelivery,
    openclaw_temporal_context: application(expect.stringContaining("## Temporal Context")),
    openclaw_permission_change: application(notice),
  });
});
