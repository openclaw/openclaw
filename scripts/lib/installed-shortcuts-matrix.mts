import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { wireMessageText } from "../../test/e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js";
import type {
  ProfileWireFixture,
  ProfileWireProvider,
} from "../../test/e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import type { startQaGatewayRpcProxy } from "../../test/fixtures/qa-gateway-rpc-proxy.mjs";

export const installedAutomaticCases = [
  "send-on",
  "send-off",
  "inspect-on",
  "inspect-off",
  "send-away",
  "send-aba",
] as const;
type CaseID = (typeof installedAutomaticCases)[number];
export const installedExplicitCases = ["explicit-fresh", "explicit-saved"] as const;
type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;
export type InstalledObservation = {
  producers: number;
  prepared: number;
  automaticEntries: number;
  automaticCompletions: number;
  explicitEntries: number;
  explicitCompletions: number;
  kind: string;
  automaticOutcome: string;
  explicitOutcome: string;
  parameterMatch: boolean;
  runMatch?: boolean;
  misattributed: boolean;
  idleUnprotectedComposer: boolean;
};
type Scenario = {
  id: CaseID;
  sessionKey: string;
  sessionName: string;
  otherSessionName: string;
  shortcutName: string;
  question: string;
  runID?: string;
};

export function assertInstalledIntentRegistration(value: unknown) {
  assert(
    isRecord(value) &&
      value.version === 1 &&
      isRecord(value.generator) &&
      value.generator.name === "xcode-tools",
    "Unsupported App Intents extraction structure",
  );
  const records = (group: unknown): Record<string, unknown>[] => {
    assert(isRecord(group) || Array.isArray(group), "Missing App Intents registration group");
    const entries = Object.values(group);
    assert(entries.every(isRecord));
    return entries;
  };
  const select = (group: unknown, name: string) => {
    const matches = records(group).filter(
      (record) => record.fullyQualifiedTypeName === `OpenClawKit.${name}`,
    );
    assert.equal(matches.length, 1, "Missing or duplicate compiled intent registration");
    assert(
      typeof matches[0]!.mangledTypeName === "string" && matches[0]!.mangledTypeName.length > 0,
    );
    return matches[0]!;
  };
  const entities = new Map<string, string>();
  for (const name of ["OpenClawSessionEntity", "OpenClawRunEntity"]) {
    const entity = select(value.entities, name);
    assert(typeof entity.typeName === "string" && entity.typeName.length > 0);
    assert(
      typeof entity.defaultQueryIdentifier === "string" && entity.defaultQueryIdentifier.length > 0,
    );
    const queries: Record<string, unknown>[] = records(value.queries).filter(
      (query) => query.fullyQualifiedIdentifier === entity.defaultQueryIdentifier,
    );
    assert.equal(queries.length, 1);
    assert.equal(queries[0]!.entityType, entity.typeName);
    entities.set(name, entity.typeName);
  }
  for (const [name, parameters, target, entity] of [
    ["OpenRunIntent", ["automatic", "presentationID", "target"], "target", "OpenClawRunEntity"],
    ["SendMessageIntent", ["message", "session"], "session", "OpenClawSessionEntity"],
    ["InspectRunIntent", ["run"], "run", "OpenClawRunEntity"],
  ] as const) {
    const action = select(value.actions, name);
    assert(
      typeof action.identifier === "string" &&
        action.identifier.length > 0 &&
        action.isDiscoverable === true,
    );
    assert(Array.isArray(action.parameters) && action.parameters.every(isRecord));
    assert.deepEqual(
      action.parameters
        .map((parameter) => parameter.name)
        .toSorted((a, b) => String(a).localeCompare(String(b))),
      parameters,
    );
    const parameter = action.parameters.find((entry) => entry.name === target)!;
    assert(
      isRecord(parameter.valueType) &&
        isRecord(parameter.valueType.entity) &&
        isRecord(parameter.valueType.entity.wrapper),
    );
    assert.equal(parameter.valueType.entity.wrapper.typeName, entities.get(entity));
  }
  // The effective Bool/optional defaults and parameter visibility are qualified
  // by real fresh/saved Shortcuts delivery, not undocumented JSON encodings.
}

export function readInstalledObservation(value: unknown): InstalledObservation {
  assert(isRecord(value), "Missing installed owner observation");
  for (const field of [
    "producers",
    "prepared",
    "automaticEntries",
    "automaticCompletions",
    "explicitEntries",
    "explicitCompletions",
  ]) {
    assert(
      Number.isSafeInteger(value[field]) && Number(value[field]) >= 0 && Number(value[field]) <= 64,
      "Invalid installed observation counter",
    );
  }
  assert(["none", "send", "inspect"].includes(String(value.kind)));
  assert(["none", "opened", "skipped", "error"].includes(String(value.automaticOutcome)));
  assert(["none", "opened", "cancelled", "unavailable"].includes(String(value.explicitOutcome)));
  assert.equal(typeof value.parameterMatch, "boolean");
  assert.equal(typeof value.misattributed, "boolean");
  assert.equal(typeof value.idleUnprotectedComposer, "boolean");
  assert(value.runMatch === undefined || typeof value.runMatch === "boolean");
  return value as InstalledObservation;
}

/** A checkpoint request is not evidence that the returned intent completed. */
export function assertInstalledObservation(
  id: CaseID,
  before: InstalledObservation,
  after: InstalledObservation,
  downstream: boolean,
) {
  const automatic = !id.endsWith("-off");
  assert(
    !before.misattributed && !after.misattributed,
    "Overlapping or misattributed owner observation",
  );
  assert(before.idleUnprotectedComposer, "The previous composer has not settled");
  if (downstream || id === "send-away" || id === "send-aba") {
    assert(
      after.idleUnprotectedComposer,
      "Composer protection could mask stale-navigation admission",
    );
  }
  assert.equal(after.producers, before.producers + 1);
  assert.equal(after.prepared, before.prepared + 1);
  assert.equal(after.kind, id.startsWith("send") ? "send" : "inspect");
  assert.equal(after.automaticEntries, before.automaticEntries + Number(automatic));
  assert.equal(after.automaticCompletions, before.automaticCompletions + Number(automatic));
  assert.equal(after.parameterMatch, automatic);
  assert.equal(
    after.automaticOutcome,
    automatic ? (id === "send-away" || id === "send-aba" ? "skipped" : "opened") : "none",
  );
  assert.equal(after.explicitEntries, before.explicitEntries + Number(downstream));
  assert.equal(after.explicitCompletions, before.explicitCompletions + Number(downstream));
  assert.equal(after.explicitOutcome, downstream ? "opened" : "none");
  if (downstream) {
    // Send OFF has no observed Run at preparation. Its association comes from
    // actual wire/history and the real earlier-action magic variable, not a mock.
    assert.equal(after.runMatch, id === "send-off" ? undefined : true);
  }
}

export function assertInstalledExplicitObservation(
  before: InstalledObservation,
  after: InstalledObservation,
) {
  assert(!before.misattributed && !after.misattributed);
  for (const key of [
    "producers",
    "prepared",
    "automaticEntries",
    "automaticCompletions",
  ] as const) {
    assert.equal(after[key], before[key], "Explicit Open Run must not enter the automatic path");
  }
  assert.equal(after.explicitEntries, before.explicitEntries + 1);
  assert.equal(after.explicitCompletions, before.explicitCompletions + 1);
  assert.equal(after.explicitOutcome, "opened");
  assert.equal(after.runMatch, true);
}

export async function createInstalledShortcutsMatrix(
  fixture: ProfileWireFixture<ProfileWireProvider>,
  proxy: Proxy,
  controlToken: string,
  suffix: string,
) {
  const scenarios: Scenario[] = [];
  for (const id of installedAutomaticCases) {
    const name = `ios-siri-${id}-${suffix}`;
    const sessionKey = await fixture.createSession(name);
    const other = `${name}-empty`;
    const otherKey = await fixture.createSession(other);
    // The ordinary colored-session header exposes the selected session title.
    // This is an empty editor witness, not a protected draft blocking admission.
    for (const key of [sessionKey, otherKey]) {
      await fixture.admin.request("sessions.patch", { key, color: "blue" });
    }
    const question = `Reply exactly \`SIRI-${id}-${suffix}\`.`;
    let runID: string | undefined;
    if (id.startsWith("inspect")) {
      const sent = await fixture.alice.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: question,
        idempotencyKey: randomUUID(),
        deliver: false,
      });
      runID = sent.runId;
      const result = await fixture.admin.request<{ status: string }>(
        "agent.wait",
        { runId: runID, timeoutMs: 30_000 },
        35_000,
      );
      assert.equal(result.status, "ok");
    }
    scenarios.push({
      id,
      sessionKey,
      sessionName: `Profile binding ${name}`,
      otherSessionName: `Profile binding ${other}`,
      shortcutName: `OpenClaw ${name}`,
      question,
      runID,
    });
  }
  const token = randomUUID();
  const abort = new AbortController();
  const tasks = new Set<Promise<void>>();
  const receipts: Array<Record<string, unknown>> = [];
  const explicitReceipts: Array<Record<string, unknown>> = [];
  let bootstrapEvents: ReturnType<Proxy["snapshot"]>["events"] = [];
  let lastRun: { scenario: Scenario; runID: string } | undefined;
  let explicit:
    | { id: string; baseline: InstalledObservation; cursor: number; finished: boolean }
    | undefined;
  let failed = false;
  let stopping = false;
  let active:
    | {
        scenario: Scenario;
        cursor: number;
        baseline: InstalledObservation;
        held: boolean;
        observed: boolean;
        checkpoint: boolean;
        released: boolean;
        finished: boolean;
        release?: () => void;
      }
    | undefined;
  const proxyControl = async (action: string, signal = abort.signal) => {
    const response = await fetch(proxy.controlUrl, {
      method: "POST",
      headers: { "x-qa-fixture-token": controlToken },
      body: JSON.stringify({ action, method: "chat.send" }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
    });
    assert(response.ok, "Installed proxy control failed");
    return await response.json();
  };
  const accepted = async () => {
    assert(active);
    const events = proxy.snapshot().events.slice(active.cursor);
    const requests = events.filter(
      (event) => event.kind === "rpc-request" && event.method === "chat.send",
    );
    const responses = events.filter((event) => event.kind === "send-response" && event.ok === true);
    const sends = active.scenario.id.startsWith("send") ? 1 : 0;
    assert.equal(requests.length, sends, "Wrong native submission count");
    assert.equal(responses.length, sends, "Wrong native admission count");
    const runID = sends ? responses[0]!.runId : active.scenario.runID;
    assert.equal(typeof runID, "string");
    if (sends) {
      assert.equal(requests[0]!.sessionKey, active.scenario.sessionKey);
      assert.equal(requests[0]!.expectedProfileId, fixture.aliceId);
      assert.equal(requests[0]!.connection, responses[0]!.connection);
    }
    assert(!events.some((event) => event.kind === "rpc-request" && event.method === "chat.abort"));
    const history = await fixture.admin.request<{
      sessionInfo: { key: string; agentId: string };
      messages: Array<{
        role?: string;
        __openclaw?: { idempotencyKey?: string };
        content?: Array<{ text?: string }>;
      }>;
    }>("chat.history", { sessionKey: active.scenario.sessionKey, agentId: "qa", limit: 100 });
    assert.equal(history.sessionInfo.key, active.scenario.sessionKey);
    assert.equal(history.sessionInfo.agentId, "qa");
    const admitted = history.messages.filter(
      (message) =>
        message.role === "user" && message["__openclaw"]?.idempotencyKey === `${runID}:user`,
    );
    assert.equal(admitted.length, 1);
    assert.equal(wireMessageText(admitted[0]), active.scenario.question);
    return runID as string;
  };
  const handle = async (input: unknown) => {
    assert(isRecord(input) && !stopping && !failed);
    if (input.action === "begin-explicit") {
      assert(!active && !explicit && lastRun && receipts.length === scenarios.length);
      assert.equal(input.id, installedExplicitCases[explicitReceipts.length]);
      await proxyControl("reset");
      const baseline = readInstalledObservation(input.observation);
      assert(baseline.idleUnprotectedComposer, "The previous composer has not settled");
      explicit = {
        id: String(input.id),
        baseline,
        cursor: proxy.snapshot().events.length,
        finished: false,
      };
      return { successURL: `${baseURL}/${explicit.id}/success` };
    }
    if (input.action === "complete-explicit") {
      assert(explicit && lastRun && input.id === explicit.id);
      assertInstalledExplicitObservation(
        explicit.baseline,
        readInstalledObservation(input.observation),
      );
      assert.equal(input.uiVerified, true);
      assert.equal(input.shortcutSucceeded, true);
      if (explicit.id === "explicit-saved") {
        assert(explicit.finished);
      }
      const events = proxy.snapshot().events.slice(explicit.cursor);
      assert(
        !events.some(
          (event) =>
            event.kind === "rpc-request" &&
            ["chat.send", "chat.abort"].includes(String(event.method)),
        ),
      );
      const reads = events.filter(
        (event) =>
          event.kind === "rpc-request" &&
          event.method === "chat.history" &&
          event.inputRunIds?.length,
      );
      assert(reads.length > 0);
      for (const event of reads) {
        assert.deepEqual(event.inputRunIds, [lastRun.runID]);
        assert.equal(event.inputRunIdsTruncated, false);
        assert.equal(event.sessionKey, lastRun.scenario.sessionKey);
        assert.equal(event.expectedProfileId, fixture.aliceId);
      }
      explicitReceipts.push({
        id: explicit.id,
        ordinaryEntry: true,
        automaticEntries: 0,
        outcome: "opened",
        originalRunMatched: true,
        hiddenFieldsVerified: true,
        sends: 0,
      });
      explicit = undefined;
      return {};
    }
    if (input.action === "explicit-status") {
      assert(explicit && input.id === explicit.id);
      return { finished: explicit.finished };
    }
    if (input.action === "begin") {
      assert(!active && receipts.length < scenarios.length);
      const scenario = scenarios[receipts.length]!;
      assert.equal(input.id, scenario.id, "Installed cases must execute in order");
      // Keep the canonical per-case evidence bound. Preserve initial onboarding
      // facts once, then reset only after the previous case fully completed.
      if (receipts.length > 0) {
        await proxyControl("reset");
      }
      const baseline = readInstalledObservation(input.observation);
      assert(baseline.idleUnprotectedComposer, "The previous composer has not settled");
      active = {
        scenario,
        cursor: proxy.snapshot().events.length,
        baseline,
        held: false,
        observed: false,
        checkpoint: false,
        released: false,
        finished: false,
      };
      if (scenario.id === "send-away" || scenario.id === "send-aba") {
        await proxyControl("hold-response");
        active.held = true;
      }
      return {};
    }
    assert(active && input.id === active.scenario.id, "Wrong installed case owner");
    switch (input.action) {
      case "status":
        return { checkpoint: active.checkpoint, finished: active.finished };
      case "wait-held":
        assert(active.held);
        await proxyControl("wait-held");
        // Complete inference while keeping the actual acceptance response held.
        // A -> B -> A must return to an idle editor, not a still-running guard.
        {
          const runID = await accepted();
          const terminal = await fixture.admin.request<{ status: string }>(
            "agent.wait",
            { runId: runID, timeoutMs: 30_000 },
            35_000,
          );
          assert.equal(terminal.status, "ok");
        }
        return {};
      case "release-ack":
        assert(active.held && input.emptyEditor === true && input.selectedOwnerVerified === true);
        assert(
          readInstalledObservation(input.observation).idleUnprotectedComposer,
          "The selected composer is not idle",
        );
        await proxyControl("release-response");
        active.held = false;
        return {};
      case "observe": {
        assert(!active.observed && !active.held);
        if (active.scenario.id.endsWith("-off")) {
          assert(active.checkpoint, "The OFF producer has not returned");
        }
        assertInstalledObservation(
          active.scenario.id,
          active.baseline,
          readInstalledObservation(input.observation),
          false,
        );
        assert.equal(input.uiVerified, true);
        const runID = await accepted();
        active.observed = true;
        return { runID };
      }
      case "release-downstream":
        assert(active.observed && active.checkpoint && !active.released);
        active.released = true;
        active.release?.();
        return {};
      case "complete": {
        assert(active.observed && active.checkpoint && active.released && active.finished);
        assertInstalledObservation(
          active.scenario.id,
          active.baseline,
          readInstalledObservation(input.observation),
          true,
        );
        assert.equal(input.uiVerified, true);
        const runID = await accepted();
        const scoped = proxy
          .snapshot()
          .events.slice(active.cursor)
          .filter(
            (event) =>
              event.kind === "rpc-request" &&
              event.method === "chat.history" &&
              event.inputRunIds?.length,
          );
        assert(scoped.length > 0, "The explicit open did not read the actual accepted Run");
        for (const event of scoped) {
          assert.deepEqual(event.inputRunIds, [runID]);
          assert.equal(event.inputRunIdsTruncated, false);
          assert.equal(event.sessionKey, active.scenario.sessionKey);
          assert.equal(event.expectedProfileId, fixture.aliceId);
        }
        if (receipts.length === 0) {
          bootstrapEvents = proxy.snapshot().events;
        }
        receipts.push({
          id: active.scenario.id,
          automatic: !active.scenario.id.endsWith("-off"),
          outcome:
            active.scenario.id === "send-away" || active.scenario.id === "send-aba"
              ? "skipped"
              : active.scenario.id.endsWith("-off")
                ? "not-invoked"
                : "opened",
          originalParametersMatched: active.scenario.id.endsWith("-off") ? null : true,
          automaticRunComparedWithDownstream: active.scenario.id.endsWith("-off") ? null : true,
          acceptedHistoryMatched: true,
          downstreamRunMatched: true,
          shortcutSucceeded: true,
          sends: active.scenario.id.startsWith("send") ? 1 : 0,
        });
        lastRun = { scenario: active.scenario, runID };
        active = undefined;
        return {};
      }
      default:
        throw new Error("Unknown installed proof control");
    }
  };
  const server = createServer((request, response) => {
    const task = (async () => {
      assert(!stopping && tasks.size < 8);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === `/${token}/control`) {
        let body = "";
        for await (const part of request) {
          body += String(part);
          assert(Buffer.byteLength(body) <= 4096);
        }
        const result = await handle(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      assert(request.method === "GET");
      if (explicit && url.pathname === `/${token}/${explicit.id}/success`) {
        assert(explicit.id === "explicit-saved" && !explicit.finished);
        explicit.finished = true;
        response.writeHead(200).end("complete");
        return;
      }
      assert(active);
      if (url.pathname === `/${token}/${active.scenario.id}/checkpoint`) {
        assert(!active.checkpoint);
        active.checkpoint = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const selected = active;
        try {
          await new Promise<void>((resolve, reject) => {
            selected.release = resolve;
            timer = setTimeout(
              () => reject(new Error("Downstream checkpoint was not released")),
              45_000,
            );
            response.once("close", () => {
              if (!selected.released && !stopping) {
                reject(new Error("Downstream checkpoint was abandoned"));
              }
            });
          });
          assert(selected.released && !stopping);
        } finally {
          clearTimeout(timer);
          selected.release = undefined;
        }
        response.writeHead(200, { "content-type": "text/plain" }).end("continue");
        return;
      }
      assert.equal(url.pathname, `/${token}/${active.scenario.id}/success`);
      assert(active.released && !active.finished);
      active.finished = true;
      response.writeHead(200).end("complete");
    })().catch(() => {
      if (!stopping) {
        failed = true;
      }
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end("installed proof refused");
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}/${token}`;
  return {
    scenarios: scenarios.map((scenario) =>
      Object.assign({}, scenario, {
        checkpointURL: `${baseURL}/${scenario.id}/checkpoint`,
        successURL: `${baseURL}/${scenario.id}/success`,
      }),
    ),
    controlURL: `${baseURL}/control`,
    handle,
    bootstrapEvents: () => [...bootstrapEvents],
    receipts: () => [...receipts, ...explicitReceipts].map((receipt) => Object.assign({}, receipt)),
    verifyComplete() {
      assert(!failed && !active && !explicit && !stopping);
      assert.deepEqual(
        receipts.map((receipt) => receipt.id),
        [...installedAutomaticCases],
      );
      assert.deepEqual(
        explicitReceipts.map((receipt) => receipt.id),
        [...installedExplicitCases],
      );
    },
    async releaseGates() {
      stopping = true;
      active?.release?.();
      abort.abort();
      if (active?.held && proxy.snapshot().heldResponse) {
        await proxyControl("release-response", new AbortController().signal);
        active.held = false;
      }
    },
    async stop() {
      assert(stopping, "Release installed gates before dependent teardown");
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await Promise.all([...tasks, closed]);
    },
  };
}
