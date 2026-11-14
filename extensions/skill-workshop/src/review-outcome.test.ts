import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { WorkshopChange } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkshopMutationContext } from "./library.js";
import { postWorkshopChangeNotice } from "./review-outcome.js";
import {
  undoWorkshopReview,
  WorkshopReviewNotFoundError as NotFound,
  workshopReviewRunId,
} from "./review-undo.js";
import { setWorkshopRuntime } from "./runtime.js";
import { workshopPluginConfig } from "./test-support.js";

// The plugin owns what the notice says and how undo reverts; the host's postSessionNotice owns
// generation fencing, channel delivery, the transcript row and the system event. Those are pinned
// in src/plugins/runtime/runtime-session-notice.e2e.test.ts and, through a real review, in
// src/gateway/gateway-review.workshop-contract.e2e.test.ts.
const mocks = vi.hoisted(() => ({
  postSessionNotice: vi.fn(),
  enqueueSystemEvent: vi.fn(() => true),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

type ChangeInput = Pick<WorkshopChange, "skillName" | "action"> & Partial<WorkshopChange>;
const { feed, record, library } = vi.hoisted(() => {
  const changes: WorkshopChange[] = [];
  function append(ctx: WorkshopMutationContext, change: ChangeInput): WorkshopChange {
    const row: WorkshopChange = {
      id: `c${changes.length + 1}`,
      agentId: ctx.agentId,
      actor: ctx.actor,
      summary: change.action,
      createdAtMs: changes.length + 1,
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...change,
    };
    changes.push(row);
    return row;
  }
  const mutate =
    (action: "restore" | "archive") =>
    async (ctx: WorkshopMutationContext, { name }: { name: string }) =>
      append(ctx, { skillName: name, action });
  return {
    feed: changes,
    record: append,
    library: {
      listWorkshopChanges: vi.fn(
        async (id: string, { runId, limit }: { runId?: string; limit: number }) =>
          changes
            .filter((row) => row.agentId === id && (runId === undefined || row.runId === runId))
            .toReversed()
            .slice(0, limit),
      ),
      listWorkshopArchive: vi.fn(async () => [
        { name: "deploy", versions: [{ id: "v-before-review" }] },
      ]),
      listWorkshopSkills: vi.fn(async () => [{ name: "release" }]),
      restoreWorkshopSkill: vi.fn(mutate("restore")),
      archiveWorkshopSkill: vi.fn(mutate("archive")),
    },
  };
});
vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  ...library,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postSessionNotice.mockResolvedValue({ status: "posted", delivered: true });
  setWorkshopRuntime({
    system: {
      postSessionNotice: mocks.postSessionNotice,
      enqueueSystemEvent: mocks.enqueueSystemEvent,
    },
    logging: { getChildLogger: () => mocks.log },
  } as unknown as PluginRuntime); // SAFETY: notice and undo read only these runtime members.
});

describe("postWorkshopChangeNotice", () => {
  const change = (overrides: Partial<WorkshopChange>): WorkshopChange => ({
    id: "c1",
    agentId: "main",
    skillName: "budget",
    action: "patch",
    actor: "review",
    summary: "reconciled",
    createdAtMs: 1,
    ...overrides,
  });
  const generation = (sessionKey: string) => ({
    agentId: "main",
    storePath: "/tmp/sessions.json",
    sessionKey,
    sessionId: "reviewed-session",
    lifecycleRevision: "reviewed-revision",
  });
  const reviewId = "0b6a4a52-1f43-4f0e-9d55-3c1d8e1f7a10";
  const runId = `skill-workshop-review:${reviewId}`;
  const channelNotices: OpenClawConfig = workshopPluginConfig({
    autonomous: { channelNotices: true },
  });
  const reviewChanges = (
    summary = "first pass",
    lastEdit: Partial<WorkshopChange> = { summary: "typo" },
  ) => [
    change({ versionId: "v2", createdAtMs: 2 }),
    change({ summary, versionId: "v1", createdAtMs: 1 }),
    change({ skillName: "notes", action: "create", summary: "drafting", createdAtMs: 3 }),
    change({ skillName: "notes", createdAtMs: 4, ...lastEdit }),
  ];
  const noticeData = (includeNotes = false) => ({
    agentId: "main",
    runId,
    skills: [
      { name: "budget", action: "updated", summary: "reconciled" },
      ...(includeNotes ? [{ name: "notes", action: "created", summary: "drafting" }] : []),
    ],
  });
  const undoButton = {
    blocks: [
      {
        type: "buttons",
        buttons: [
          { label: "Undo", action: { type: "command", command: `/learn undo ${reviewId}` } },
        ],
      },
    ],
  };
  const post = (
    changes: WorkshopChange[],
    sessionKey = "agent:main:telegram:direct:42",
    config: OpenClawConfig = {},
  ) => postWorkshopChangeNotice({ config, generation: generation(sessionKey), runId, changes });
  const posted = () => {
    expect(mocks.postSessionNotice).toHaveBeenCalledOnce();
    return mocks.postSessionNotice.mock.calls[0]![0];
  };

  it("stays quiet when the review changed nothing", async () => {
    await post([]);
    expect(mocks.postSessionNotice).not.toHaveBeenCalled();
  });

  it("posts one line with an Undo command button and the revert calls when channel notices are enabled", async () => {
    const sessionKey = "agent:main:discord:channel:123:thread:456";
    await post(reviewChanges(), sessionKey, channelNotices);

    const request = posted();
    expect(request).toMatchObject({
      generation: generation(sessionKey),
      notice: {
        type: "skills-changed",
        text: '💾 Learned: updated `budget` (reconciled); created `notes` (drafting). Say "undo" to revert this skill change.',
        presentation: undoButton,
        data: noticeData(true),
      },
      idempotencyKey: `skill-workshop-notice:${runId}`,
      // Slack never gets a channel message.
      deliver: { skipChannels: ["slack"] },
    });
    expect(request.systemEvent).toContain("skill_workshop action=restore name=budget version=v1;");
    expect(request.systemEvent).toContain('skill_workshop action=archive name=notes reason="undo"');
  });

  it("records a transcript-only notice when channel notices are off", async () => {
    await post(reviewChanges("reconciled", { versionId: "v-typo" }));

    const request = posted();
    expect(request).not.toHaveProperty("deliver");
    expect(request.notice).toMatchObject({
      text: expect.stringContaining("💾 Learned: updated `budget`"),
      data: noticeData(true),
    });
    // The creation is kept over the later edit, so undo archives the created skill.
    expect(request.systemEvent).toContain('skill_workshop action=archive name=notes reason="undo"');
  });

  it.each([
    [
      "skipped",
      { status: "skipped", reason: "session-changed" },
      "debug",
      "skill workshop notice skipped: session agent:main:telegram:direct:42 was reset",
    ],
    [
      "failed",
      { status: "failed", stage: "delivery", error: "delivery failed" },
      "warn",
      "skill workshop notice delivery failed: delivery failed",
    ],
  ] as const)(
    "logs instead of throwing when the host reports %s",
    async (_, result, level, line) => {
      mocks.postSessionNotice.mockResolvedValueOnce(result);
      await expect(post([change({})], undefined, channelNotices)).resolves.toBeUndefined();
      expect(mocks.log[level]).toHaveBeenCalledExactlyOnceWith(line);
    },
  );
});

describe("undoWorkshopReview", () => {
  const REVIEW_RUN_ID = workshopReviewRunId("review");
  const REVIEWED_SESSION = "agent:main:telegram:direct:42";
  const user: WorkshopMutationContext = { config: {}, agentId: "main", actor: "user" };
  const undo = (runId = REVIEW_RUN_ID) => undoWorkshopReview(user, { runId });
  function expectNotice(text: string) {
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(text),
      { sessionKey: REVIEWED_SESSION, agentId: "main" },
    );
  }
  async function expectRefusal(error: Error | RegExp, runId = REVIEW_RUN_ID) {
    await expect(undo(runId)).rejects.toThrow(error);
    expect(library.restoreWorkshopSkill).not.toHaveBeenCalled();
    expect(library.archiveWorkshopSkill).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    feed.length = 0;
    const review = { ...user, actor: "review" as const, sessionKey: REVIEWED_SESSION };
    const ctx = { ...review, runId: REVIEW_RUN_ID };
    record(ctx, { skillName: "deploy", action: "patch", versionId: "v-before-review" });
    record(ctx, { skillName: "release", action: "create" });
    record(ctx, { skillName: "deploy", action: "patch", versionId: "v-after-first-patch" });
  });

  it("restores edited skills, archives created ones, and tells the reviewed session", async () => {
    const result = await undo();
    const undoCtx = { ...user, runId: "skill-workshop-undo:review" };
    expect(library.restoreWorkshopSkill).toHaveBeenCalledExactlyOnceWith(undoCtx, {
      name: "deploy",
      versionId: "v-before-review",
      summary: "undid background review",
    });
    expect(library.archiveWorkshopSkill).toHaveBeenCalledExactlyOnceWith(undoCtx, {
      name: "release",
      reason: "undo",
    });
    expect(result).toMatchObject({
      status: "undone",
      changes: [
        { skillName: "deploy", action: "restore", actor: "user" },
        { skillName: "release", action: "archive", actor: "user" },
      ],
    });
    expectNotice("do not revert it again");
  });
  it("lets a concurrent second press find the review already undone", async () => {
    const [first, second] = await Promise.all([undo(), undo()]);
    expect([first.status, second.status]).toEqual(["undone", "already-undone"]);
    expect(library.archiveWorkshopSkill).toHaveBeenCalledTimes(1);
  });
  it("refuses a review id with no recorded changes", async () => {
    const runId = workshopReviewRunId("missing");
    await expectRefusal(new NotFound(`No skill changes recorded for review ${runId}.`), runId);
    await expect(undo("foreground-run")).rejects.toBeInstanceOf(NotFound);
    expect(library.restoreWorkshopSkill).not.toHaveBeenCalled();
  });
  it("refuses a review whose first changes were pruned from the full feed", async () => {
    feed.splice(1, 1);
    while (feed.length < 500) {
      record({ ...user, runId: "later" }, { skillName: `other-${feed.length}`, action: "patch" });
    }
    await expectRefusal(/too old to undo in one step/);
  });
  it("refuses before any write when a saved version is no longer kept", async () => {
    library.listWorkshopArchive.mockResolvedValueOnce([]);
    await expectRefusal(/version of "deploy" saved before it is no longer kept/);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });
  it("reports and announces the reverts that committed before a later one failed", async () => {
    library.archiveWorkshopSkill.mockRejectedValueOnce(new Error("Learning is off."));
    await expect(undo()).rejects.toThrow("Partly undone (restored `deploy`); Learning is off.");
    expectNotice("restored `deploy`");
  });
});
