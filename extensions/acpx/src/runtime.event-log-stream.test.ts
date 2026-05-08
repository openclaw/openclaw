import fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime, AcpRuntimeEvent } from "../runtime-api.js";
import { AcpxRuntime } from "./runtime.js";

// =============================================================================
// Catalog #4 RED test — `event_log.active_path` advertised but never written
// =============================================================================
//
// The published acpx package bakes a `eventLog.active_path` field into every
// session record (see node_modules/acpx/dist/prompt-turn-BY5SwU1F.js:340-358:
// `defaultSessionEventLog` -> `<acpxBaseDir>/<encodedSessionKey>.stream.ndjson`).
// That path is operator-visible — it appears in the on-disk session record at
// `~/.openclaw/workspace/state/sessions/agent%3A...%3Aacp%3A<uuid>.json` —
// but on the deployed container the file does NOT exist. Empirical proof:
// `ls /home/codeclaw/.acpx/sessions/` -> "No such file or directory".
//
// The contract is: when a `session/update` notification arrives on the wire,
// the openclaw side should write a JSON-RPC frame to the path advertised in
// the session record's `eventLog.active_path`. Today no such writer exists in
// either openclaw source (`grep -r 'stream.ndjson|active_path|event_log' src/
// extensions/` returns ZERO hits) or in the published acpx runtime
// (the package only emits the field via `defaultSessionEventLog` and never
// calls `appendFile`/`writeFile` against it; the only `writeFile` calls in
// `prompt-turn-BY5SwU1F.js` target the JSON record itself, not the stream).
//
// Note on seam shape: the published `AcpRuntimeOptions` (acpx/dist/runtime.d.ts:168)
// does NOT expose `onAcpMessage` / `onSessionUpdate` / `onAcpOutputMessage` —
// those callbacks live on the lower-level `AcpClientOptions`
// (acpx/dist/types-CVBeQyi3.d.ts:57-60), which the runtime instantiates
// internally. The cleanest available openclaw-side seam therefore is to
// intercept at `AcpxRuntime.runTurn` (extensions/acpx/src/runtime.ts:860):
// wrap the AsyncIterable so each yielded event is also serialized as a
// JSON-RPC frame and appended to `eventLog.active_path` from the loaded
// session record. (Strictly speaking that loses raw-wire fidelity since
// `runTurn` yields projector-translated `AcpRuntimeEvent`s rather than raw
// `session/update` JSON-RPC frames — but it's still operator-visible and the
// only seam the published acpx surface offers without a fork. A higher-fidelity
// fix would require upstream acpx exposing `onAcpMessage` through
// `AcpRuntimeOptions`.)
//
// EXPECTED RED today:
//   - Test 1: with a session active and a `tool_call` event yielded by the
//     delegate during `runTurn`, `fs.appendFile` is NEVER called with the
//     advertised `<tmpdir>/.acpx/sessions/<encodedKey>.stream.ndjson` path.
//     Asserting it WAS called fails today, flips GREEN once the writer lands.
//   - Test 2 (fix-shape): asserts the appended payload is parseable JSON and
//     contains `"sessionUpdate":"tool_call"`. Same RED today, flips GREEN once
//     the writer emits proper JSON-RPC frames.
//
// EXPECTED GREEN today (control):
//   - Test 3: with NO turn run (just session creation), `fs.appendFile` is NOT
//     called for the stream.ndjson path. Pinning the discriminator: the writer
//     must fire on session/update events, not on session creation alone.
//
// Sharpness: a fix that writes to a different path (e.g., a hardcoded location
// rather than the record's advertised path) would still fail Test 1's path
// match. A fix that writes plain text instead of JSON-RPC frames would fail
// Test 2's content parse. A fix that writes on every `ensureSession` (not on
// `runTurn`) would break Test 3.
// =============================================================================

const SESSION_KEY = "agent:codex:acp:binding:test";
const ACP_SESSION_ID = "session-1";

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

function encodeSessionId(sessionId: string): string {
  // Mirrors the acpx package's `safeSessionId` helper
  // (node_modules/acpx/dist/prompt-turn-BY5SwU1F.js:337). Keep this in sync if
  // upstream changes its encoding scheme.
  return encodeURIComponent(sessionId);
}

function buildAdvertisedActivePath(baseDir: string, sessionKey: string): string {
  return join(baseDir, `${encodeSessionId(sessionKey)}.stream.ndjson`);
}

function makePersistedRecord(advertisedActivePath: string) {
  return {
    schema: "acpx.session.v1",
    name: SESSION_KEY,
    acpxRecordId: SESSION_KEY,
    acpSessionId: ACP_SESSION_ID,
    agentCommand: "npx @zed-industries/codex-acp@0.13.0",
    cwd: "/tmp",
    closed: false,
    eventLog: {
      active_path: advertisedActivePath,
      segment_count: 5,
      max_segment_bytes: 1_048_576,
      max_segments: 5,
      last_write_at: undefined,
      last_write_error: null,
    },
  };
}

async function* yieldToolCallEvent(): AsyncIterable<AcpRuntimeEvent> {
  // Mirror what the acpx translator emits for a `session/update`
  // sessionUpdate: "tool_call" (node_modules/acpx/dist/runtime.js:210-217).
  yield {
    type: "tool_call",
    text: "running tool",
    tag: "tool_call",
    toolCallId: "tc-1",
    status: "in_progress",
    title: "bash",
  };
}

async function* yieldNothing(): AsyncIterable<AcpRuntimeEvent> {
  // No events → simulates a session that exists but has no in-flight turn.
  // Pinning the discriminator for Test 3.
  return;
}

async function drainEvents(events: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const collected: AcpRuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function makeFixture(advertisedActivePath: string) {
  const baseStore: TestSessionStore = {
    load: vi.fn(async () => makePersistedRecord(advertisedActivePath)),
    save: vi.fn(async () => {}),
  };
  const runtime = new AcpxRuntime({
    cwd: "/tmp",
    sessionStore: baseStore,
    agentRegistry: {
      resolve: (agentName: string) =>
        agentName === "codex" ? "npx @zed-industries/codex-acp@0.13.0" : agentName,
      list: () => ["codex"],
    },
    permissionMode: "approve-reads",
  });
  // Reach in via the same `as unknown as { delegate: ... }` pattern used in
  // runtime.test.ts and runtime.pid-liveness.test.ts. Treating `delegate` as
  // private API would be cleaner long-term, but matching the existing
  // convention keeps this test consistent with its neighbors.
  const delegate = (
    runtime as unknown as {
      delegate: {
        ensureSession: AcpRuntime["ensureSession"];
        runTurn: AcpRuntime["runTurn"];
      };
    }
  ).delegate;
  return { runtime, baseStore, delegate };
}

describe("AcpxRuntime event_log.active_path wire-byte writer (catalog #4)", () => {
  let acpxBaseDir: string;
  let appendFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Use a tmp dir to avoid touching the real ~/.acpx tree if a future fix
    // ever does write to disk during tests.
    acpxBaseDir = await mkdtemp(join(tmpdir(), "acpx-event-log-stream-test-"));
    // Default the spy to a no-op so any unexpected real fs side-effects from
    // a future fix don't escape the tmp tree. Tests can still inspect call
    // arguments via `mock.calls`.
    appendFileSpy = vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(acpxBaseDir, { recursive: true, force: true });
  });

  it(
    "RED today: when a session/update tool_call is dispatched, fs.appendFile MUST be called " +
      "with the path advertised in the session record's event_log.active_path",
    async () => {
      const advertisedActivePath = buildAdvertisedActivePath(acpxBaseDir, SESSION_KEY);
      const { runtime, delegate } = makeFixture(advertisedActivePath);
      vi.spyOn(delegate, "runTurn").mockImplementation(() => yieldToolCallEvent());

      const handle: Parameters<AcpRuntime["runTurn"]>[0]["handle"] = {
        sessionKey: SESSION_KEY,
        backend: "acpx",
        runtimeSessionName: SESSION_KEY,
        acpxRecordId: SESSION_KEY,
      };

      await drainEvents(
        runtime.runTurn({
          handle,
          text: "hello",
          mode: "prompt",
          requestId: "req-1",
        }),
      );

      // The discriminating signal: did SOMETHING write to the advertised
      // stream.ndjson path during the turn? Today: zero. After the fix: at
      // least one call whose first arg matches the advertised path.
      const matchingCalls = appendFileSpy.mock.calls.filter(([targetPath]) => {
        return typeof targetPath === "string" && targetPath === advertisedActivePath;
      });
      expect(
        matchingCalls.length,
        "No openclaw-side writer wrote to event_log.active_path during runTurn. " +
          "The acpx published session record advertises " +
          `"${advertisedActivePath}" but extensions/acpx/src/runtime.ts has no ` +
          "wire-byte writer for that path (no hits for `stream.ndjson`, " +
          "`active_path`, or `event_log` anywhere in extensions/acpx/src/). " +
          "See catalog finding #4: implement a writer in `AcpxRuntime.runTurn` " +
          "that appends a JSON-RPC frame for each yielded event to the " +
          "session record's eventLog.active_path.",
      ).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    "RED today (fix-shape): the appended payload is parseable JSON containing " +
      '"sessionUpdate":"tool_call"',
    async () => {
      const advertisedActivePath = buildAdvertisedActivePath(acpxBaseDir, SESSION_KEY);
      const { runtime, delegate } = makeFixture(advertisedActivePath);
      vi.spyOn(delegate, "runTurn").mockImplementation(() => yieldToolCallEvent());

      const handle: Parameters<AcpRuntime["runTurn"]>[0]["handle"] = {
        sessionKey: SESSION_KEY,
        backend: "acpx",
        runtimeSessionName: SESSION_KEY,
        acpxRecordId: SESSION_KEY,
      };

      await drainEvents(
        runtime.runTurn({
          handle,
          text: "hello",
          mode: "prompt",
          requestId: "req-1",
        }),
      );

      const matchingCalls = appendFileSpy.mock.calls.filter(([targetPath]) => {
        return typeof targetPath === "string" && targetPath === advertisedActivePath;
      });
      // Fail-fast guard so the parse step doesn't blow up with a confusing
      // index-out-of-bounds error before the path-match assertion above gets a
      // chance to surface its own message.
      expect(
        matchingCalls.length,
        "Pre-condition for fix-shape check: at least one appendFile call to " +
          "the advertised stream.ndjson path is required before parsing " +
          "appended frame content. See sibling RED test for the missing " +
          "writer. Catalog #4.",
      ).toBeGreaterThanOrEqual(1);

      // Each appendFile call should write a single ndjson line that parses as
      // a JSON-RPC notification of method `session/update` with a sessionUpdate
      // body whose discriminator is `tool_call`. Loose-but-discriminating
      // shape — keeps the test from over-pinning a future writer's exact
      // framing convention while still proving the payload is structured.
      const payloads = matchingCalls
        .map(([, payload]) => (typeof payload === "string" ? payload : payload?.toString("utf8")))
        .filter((value): value is string => typeof value === "string");
      const parsedFrames = payloads
        .flatMap((payload) => payload.split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        });
      const toolCallFrame = parsedFrames.find((frame) => {
        if (typeof frame !== "object" || frame === null) {
          return false;
        }
        const params = (frame as { params?: unknown }).params;
        if (typeof params !== "object" || params === null) {
          return false;
        }
        const update = (params as { update?: unknown }).update;
        if (typeof update !== "object" || update === null) {
          return false;
        }
        return (update as { sessionUpdate?: unknown }).sessionUpdate === "tool_call";
      });
      expect(
        toolCallFrame,
        "Wire-byte writer landed but is NOT emitting parseable JSON-RPC " +
          'session/update frames containing `"sessionUpdate":"tool_call"`. ' +
          "Catalog #4 fix shape: write one JSON-RPC notification per " +
          "sessionUpdate (one ndjson line per frame).",
      ).toBeDefined();
    },
  );

  it(
    "GREEN control: with NO session/update event dispatched, fs.appendFile is NOT called " +
      "for the stream.ndjson path",
    async () => {
      // Guards against a sloppy fix that writes to the path on every
      // ensureSession or session-store load. The contract is event-driven:
      // a write only when a sessionUpdate arrives.
      const advertisedActivePath = buildAdvertisedActivePath(acpxBaseDir, SESSION_KEY);
      const { runtime, delegate } = makeFixture(advertisedActivePath);
      vi.spyOn(delegate, "ensureSession").mockResolvedValue({
        sessionKey: SESSION_KEY,
        backend: "acpx",
        runtimeSessionName: SESSION_KEY,
      });
      // Important: no runTurn invocation. Just a session-creation handshake.
      vi.spyOn(delegate, "runTurn").mockImplementation(() => yieldNothing());

      await runtime.ensureSession({
        sessionKey: SESSION_KEY,
        agent: "codex",
        mode: "persistent",
      });

      const matchingCalls = appendFileSpy.mock.calls.filter(([targetPath]) => {
        return typeof targetPath === "string" && targetPath === advertisedActivePath;
      });
      expect(
        matchingCalls.length,
        "ensureSession alone (with no session/update) wrote to the " +
          "stream.ndjson path. The wire-byte writer must be event-driven, not " +
          "fire on session creation. Catalog #4.",
      ).toBe(0);
    },
  );
});
