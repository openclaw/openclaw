import { createHash } from "node:crypto";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  openBeamMirrorEnrollment,
  type MirrorPublicationStoreValue,
} from "./mirror-publication.js";
import * as transport from "./mirror-v2.js";

vi.mock("./mirror-v2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mirror-v2.js")>()),
  enrollBeamMirrorV2: vi.fn(),
  inspectBeamMirrorV2Enrollment: vi.fn(),
  publishBeamMirrorV2: vi.fn(),
}));
const source = {
  catalogId: "example",
  hostId: "gateway",
  threadId: "thread",
  agentId: "main",
  sourceHomeId: "home",
};
const raw = Buffer.from("synthetic reviewed packet"),
  id = "a".repeat(32);
const digest = (body: Buffer) => "sha256:" + createHash("sha256").update(body).digest("hex");
const head = { generation: "publication-1", revision: '"revision-1"', sha256: digest(raw) };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const open = (
  explicit = false,
  token = "publisher-test",
  endpoint = "https://team.example/api/v2/beam",
) =>
  openBeamMirrorEnrollment({
    source,
    token,
    endpoint,
    signal: new AbortController().signal,
    assertCurrent: () => {},
    explicit,
    store: createPluginStateKeyedStoreV2ForTests<MirrorPublicationStoreValue>(
      "beam",
      { namespace: "mirror-publications", retention: "retained", env: state.env },
      { assertCurrent() {} },
    ),
  });
beforeEach(async () => {
  vi.clearAllMocks();
  resetPluginStateStoreForTests();
  state = await createOpenClawTestState({ label: "beam-mirror-enrollment" });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await state.cleanup();
});

it("requires a positive operator enrollment and keeps a released generation fenced on reopen", async () => {
  expect(await open()).toBeUndefined();
  vi.mocked(transport.enrollBeamMirrorV2).mockResolvedValueOnce({ state: "published", head });
  const explicit = (await open(true))!;
  await expect(explicit.enroll(id, raw)).resolves.toMatchObject({ state: "published", head });
  const later = (await open())!;
  expect(later.sourceSalt).toBe(explicit.sourceSalt);
  vi.mocked(transport.publishBeamMirrorV2).mockResolvedValueOnce({ state: "released" });
  await expect(later.publish(id, Buffer.from("new bytes"))).resolves.toBe("retired");
  expect((await open(true))?.fenced).toBe("released");
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
  await expect(open(false, "different-publisher")).rejects.toThrow("credential");
  expect(await open(false, "publisher-test", "https://other.example/api/v2/beam")).toBeUndefined();
});

it("keeps first-create uncertainty operator-owned and binds only a consciously selected receiver generation", async () => {
  vi.mocked(transport.enrollBeamMirrorV2).mockRejectedValueOnce(new Error("connection lost"));
  await expect((await open(true))!.enroll(id, raw)).rejects.toThrow("connection lost");
  expect((await open())?.active).toBe(false);
  await expect((await open())!.publish(id, raw)).resolves.toBe(false);
  await expect((await open(true))!.enroll(id, raw)).resolves.toMatchObject({
    state: "unconfirmed",
    beamId: id,
  });
  vi.mocked(transport.inspectBeamMirrorV2Enrollment).mockResolvedValue({ state: "observed", head });
  await expect((await open(true))!.enroll(id, raw, "wrong-generation")).rejects.toThrow(
    "could not be confirmed",
  );
  expect((await open())?.active).toBe(false);
  await expect((await open(true))!.enroll(id, raw, head.generation)).resolves.toMatchObject({
    state: "published",
    head,
  });
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
});

it("replays the exact pending bytes and precondition after restart before accepting a newer candidate", async () => {
  vi.mocked(transport.enrollBeamMirrorV2).mockResolvedValueOnce({ state: "published", head });
  await (await open(true))!.enroll(id, raw);
  const first = Buffer.from("edit one"),
    later = Buffer.from("edit two");
  vi.mocked(transport.publishBeamMirrorV2)
    .mockRejectedValueOnce(new Error("lost acknowledgement"))
    .mockResolvedValueOnce({
      state: "published",
      head: { ...head, revision: '"revision-2"', sha256: digest(first) },
    });
  await expect((await open())!.publish(id, first)).rejects.toThrow("lost acknowledgement");
  await expect((await open())!.publish(id, later)).resolves.toBe(false);
  const [attempt, replay] = vi.mocked(transport.publishBeamMirrorV2).mock.calls;
  expect(replay?.[0].intent).toEqual(attempt?.[0].intent);
  expect(replay?.[0].raw).toEqual(first);
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
});
