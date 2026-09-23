import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as secureRequest } from "node:https";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ProfileWireFixture,
  ProfileWireProvider,
} from "../../test/e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import { nativeVisualProofPNG } from "../../test/fixtures/native-visual-proof.js";
import type { startQaGatewayRpcProxy } from "../../test/fixtures/qa-gateway-rpc-proxy.mjs";
import {
  assertNativeUIForward,
  nativePhoneWitnesses,
  nativeTabletWitnesses,
  readNativeUIObservation,
  type NativeUIKind,
  type NativeUIObservation,
} from "./installed-native-ui-contract.mts";

type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;
type Session = {
  key: string;
  name: string;
  runID: string;
  prompt: string;
  priorPrompt?: string;
  entryIDs: string[];
};
export type Approval = {
  sessionKey: string;
  runID?: string;
  id?: string;
  hash?: string;
  requestID?: string;
  decisionTaken?: boolean;
  joined: boolean;
};
const approvalPrompt = "tool search qa check target=openclaw openclaw_fixture=logging-level-info";

const records = (value: unknown): Record<string, unknown>[] => {
  assert(Array.isArray(value) && value.every(isRecord));
  return value;
};
const pendingApprovals = async (fixture: ProfileWireFixture<ProfileWireProvider>) =>
  records(await fixture.admin.request("openclaw.approval.list", {}));
const approvalSnapshot = async (fixture: ProfileWireFixture<ProfileWireProvider>, id: string) => {
  const value = await fixture.admin.request<{ approval: unknown }>("approval.get", { id });
  assert(isRecord(value.approval) && isRecord(value.approval.presentation));
  return value.approval;
};
const sameApproval = (value: Record<string, unknown>, expected: Approval) => {
  assert.equal(value.id, expected.id);
  assert(isRecord(value.presentation));
  assert.equal(value.presentation.kind, "system-agent");
  assert.equal(value.presentation.proposalHash, expected.hash);
};

export async function settleNativeUIApproval(
  approval: Approval | undefined,
  fixture: ProfileWireFixture<ProfileWireProvider>,
  releaseHeld: () => Promise<void>,
) {
  if (!approval || approval.joined) {
    return;
  }
  assert(
    approval.id && approval.hash && approval.runID,
    "Approval producer remains unbound; retain its fixture",
  );
  await releaseHeld();
  if (!approval.decisionTaken) {
    const result = await fixture.admin.request<{ applied: boolean; approval: unknown }>(
      "approval.resolve",
      {
        id: approval.id,
        kind: "system-agent",
        decision: "deny",
      },
    );
    assert.equal(result.applied, true, "Cleanup did not own the first approval decision");
    assert(isRecord(result.approval));
    sameApproval(result.approval, approval);
    assert.equal(result.approval.status, "denied");
    assert.equal(result.approval.decision, "deny");
    assert.equal(result.approval.reason, "user");
    // The winning denial is an authoritative fact even if later readback fails.
    approval.decisionTaken = true;
  }
  const terminal = await approvalSnapshot(fixture, approval.id);
  sameApproval(terminal, approval);
  assert.equal(terminal.status, "denied");
  assert.equal(terminal.decision, "deny");
  assert.equal(terminal.reason, "user");
  if (isRecord(terminal.source)) {
    assert.equal(terminal.source.agentId, "qa");
    assert.equal(terminal.source.sessionKey, approval.sessionKey);
  }
  assert(!(await pendingApprovals(fixture)).some((item) => item.id === approval!.id));
  const joined = await fixture.admin.request<{ status: string }>(
    "agent.wait",
    { runId: approval.runID, timeoutMs: 30_000 },
    35_000,
  );
  assert.equal(joined.status, "ok");
  const history = await fixture.admin.request<{ messages: unknown[] }>("chat.history", {
    sessionKey: approval.sessionKey,
    agentId: "qa",
    limit: 100,
  });
  const results = records(history.messages).filter(
    (item) => item.role === "toolResult" && item.toolName === "openclaw",
  );
  assert.equal(results.length, 1);
  const text = records(results[0]!.content)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  const delegated: unknown = JSON.parse(text);
  assert(isRecord(delegated));
  // The public tool result intentionally omits the internal operation-applied flag.
  // Decision, joined terminal reply, and config readback retain their separate meanings.
  assert.deepEqual(delegated, { reply: "Denied. No change." });
  const config: unknown = JSON.parse(await readFile(fixture.instance.configPath, "utf8"));
  assert(isRecord(config) && isRecord(config.logging));
  assert.equal(config.logging.level, "debug");
  approval.joined = true;
}

export function assertNativeUIApprovalReleased(
  approval: Approval | undefined,
  snapshot: ReturnType<Proxy["snapshot"]>,
  operatorConnection: number | undefined,
  expectedProfileId: string,
) {
  assert(approval && approval.id && approval.hash && approval.runID && approval.requestID);
  const reservation = snapshot.approval;
  assert(
    reservation && reservation.status === "released",
    "Native approval delivery lost its producer",
  );
  assert.equal(reservation.connection, operatorConnection);
  assert.equal(reservation.expectedProfileId, expectedProfileId);
  assert.equal(reservation.sessionKey, approval.sessionKey);
  assert.equal(reservation.agentId, "qa");
  assert.equal(reservation.approvalId, approval.id);
  assert.equal(reservation.runId, approval.runID);
  assert.equal(reservation.proposalHash, approval.hash);
  assert.equal(reservation.requestId, approval.requestID);
  assert(
    snapshot.events.some(
      (row) =>
        row.kind === "response-released" &&
        row.connection === operatorConnection &&
        row.requestId === approval!.requestID &&
        row.delivered === true,
    ),
  );
}

/** Real Gateway producers for the fixed public-control witnesses. This server cannot
 * invoke app callbacks; only the independently selected XCTest can perform UI actions. */
export async function createInstalledNativeUIMatrix(
  fixture: ProfileWireFixture<ProfileWireProvider>,
  proxy: Proxy,
  proxyToken: string,
  certificate: string,
  kind: NativeUIKind,
  suffix: string,
) {
  const createSession = async (name: string) => {
    const key = "agent:qa:native-ui-" + name;
    const result = await fixture.alice.request<{ key: string }>("sessions.create", {
      key,
      agentId: "qa",
      displayName: "Native UI " + name,
      visibility: "shared",
      worktree: false,
      cwd: fixture.instance.state.workspaceDir,
    });
    assert.equal(result.key, key);
    await fixture.admin.request("sessions.patch", { key, color: "blue" });
    const described = await fixture.alice.request<{
      session: { key: string; agentRuntime: { id: string }; permissionMode?: string };
    }>("sessions.describe", { key });
    assert.equal(described.session.key, key);
    assert.equal(described.session.agentRuntime.id, "openclaw");
    assert.notEqual(described.session.permissionMode, "full");
    return { key, name: "Native UI " + name };
  };
  const seed = async (label: string): Promise<Session> => {
    const session = await createSession(kind + "-" + label + "-" + suffix);
    const prompts =
      label === "primary"
        ? ["Native UI earlier image", "Native UI later image"]
        : ["Native UI other run"];
    let runID = "";
    for (const prompt of prompts) {
      const result = await fixture.alice.request<{ runId: string }>("chat.send", {
        sessionKey: session.key,
        agentId: "qa",
        message: prompt,
        idempotencyKey: randomUUID(),
        deliver: false,
        ...(label === "primary"
          ? {
              attachments: [
                {
                  type: "image",
                  mimeType: "image/png",
                  fileName: "native-fork.png",
                  content: nativeVisualProofPNG,
                },
              ],
            }
          : {}),
      });
      assert.equal(typeof result.runId, "string");
      const terminal = await fixture.admin.request<{ status: string }>(
        "agent.wait",
        { runId: result.runId, timeoutMs: 30_000 },
        35_000,
      );
      assert.equal(terminal.status, "ok");
      runID = result.runId;
    }
    const history = await fixture.alice.request<{ messages: unknown[] }>("chat.history", {
      sessionKey: session.key,
      agentId: "qa",
      limit: 100,
    });
    assert(Array.isArray(history.messages));
    const users = history.messages.filter(
      (value): value is Record<string, unknown> => isRecord(value) && value.role === "user",
    );
    assert.equal(users.length, prompts.length);
    if (label === "other") {
      assert.equal(
        history.messages.filter((value) => isRecord(value) && value.role === "assistant").length,
        1,
        "The shared Select Text witness requires exactly one real assistant reply",
      );
    }
    const entryIDs = users.map((message, index) => {
      const metadata = message["__openclaw"];
      assert(isRecord(metadata) && typeof metadata.id === "string");
      assert(Array.isArray(message.content));
      assert(
        message.content.some(
          (part: unknown) =>
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string" &&
            part.text.includes(prompts[index]!),
        ),
      );
      return metadata.id;
    });
    return {
      ...session,
      runID,
      prompt: prompts.at(-1)!,
      ...(prompts.length === 2 ? { priorPrompt: prompts[0] } : {}),
      entryIDs,
    };
  };
  const primary = await seed("primary");
  const other = await seed("other");
  const dashboard = await createSession(kind + "-dashboard-" + suffix);
  await fixture.alice.request("sessions.patch", { key: dashboard.key, boardFace: "dashboard" });
  const dashboardRead = await fixture.alice.request<{ session: { boardFace?: string } }>(
    "sessions.describe",
    { key: dashboard.key },
  );
  assert.equal(dashboardRead.session.boardFace, "dashboard");
  const roster = Object.entries(kind === "phone" ? nativePhoneWitnesses : nativeTabletWitnesses);
  const receipts: Array<{
    id: string;
    phases: string[];
    realControls: true;
    sends: number;
    nativeForwards: number;
  }> = [];
  const tasks = new Set<Promise<void>>();
  const proxyCalls = new Set<Promise<unknown>>();
  const abort = new AbortController();
  const token = randomUUID();
  let failed = false;
  let stopping = false;
  let busy = false;
  let operatorConnection: number | undefined;
  let approval: Approval | undefined;
  let active:
    | {
        id: string;
        steps: readonly string[];
        index: number;
        baseline?: NativeUIObservation;
        phases: string[];
        cursor: number;
        forwards: number;
        holding: boolean;
        forkKeys: string[];
      }
    | undefined;

  // Request-local CA verification leaves the host trust store unchanged. Both the
  // response and request close are joined before a control is considered complete.
  const proxyControl = (action: string, fields: Record<string, unknown> = {}, cleanup = false) => {
    const result = (async () => {
      let requestClosed!: Promise<void>;
      let responseClosed: Promise<void> | undefined;
      let body = "";
      let status: number;
      try {
        status = await new Promise<number>((resolve, reject) => {
          const request = secureRequest(
            proxy.controlUrl,
            {
              method: "POST",
              ca: certificate,
              headers: { "x-qa-fixture-token": proxyToken },
              signal: AbortSignal.any([
                ...(cleanup ? [] : [abort.signal]),
                AbortSignal.timeout(35_000),
              ]),
            },
            (response) => {
              responseClosed = new Promise((closed) => {
                response.once("close", closed);
              });
              response.setEncoding("utf8");
              response.on("data", (part: string) => {
                body += part;
                if (Buffer.byteLength(body) > 128 * 1024) {
                  request.destroy(new Error("Native proxy receipt exceeded bound"));
                }
              });
              response.once("error", reject);
              response.once("end", () => resolve(response.statusCode ?? 0));
            },
          );
          requestClosed = new Promise((closed) => {
            request.once("close", closed);
          });
          request.once("error", reject);
          request.end(JSON.stringify({ action, ...fields }));
        });
      } finally {
        await requestClosed;
        await responseClosed;
      }
      assert.equal(status, 200, "Native fixture control refused its producer");
      const value: unknown = JSON.parse(body);
      assert(isRecord(value));
      return value;
    })();
    proxyCalls.add(result);
    void result.then(
      () => proxyCalls.delete(result),
      () => proxyCalls.delete(result),
    );
    return result;
  };
  const settleApproval = () =>
    settleNativeUIApproval(approval, fixture, async () => {
      if (proxy.snapshot().heldResponse) {
        await proxyControl("release-response", {}, true);
      }
    });
  const startApproval = async () => {
    assert(active && operatorConnection !== undefined && !approval);
    const session = await createSession(kind + "-" + active.id + "-" + suffix);
    await proxyControl("hold-approval-response", {
      connection: operatorConnection,
      selector: { expectedProfileId: fixture.aliceId, sessionKey: session.key, agentId: "qa" },
    });
    // Own the attempt before submission: a missing response cannot prove the delegated run absent.
    approval = { sessionKey: session.key, joined: false };
    const sent = await fixture.alice.request<{ runId: string }>("chat.send", {
      sessionKey: session.key,
      message: approvalPrompt,
      idempotencyKey: randomUUID(),
      deliver: false,
    });
    assert.equal(typeof sent.runId, "string");
    approval.runID = sent.runId;
    await proxyControl("wait-held");
    const observed = proxy.snapshot().approval;
    assert(observed && observed.status === "held");
    assert.equal(observed.connection, operatorConnection);
    assert.equal(observed.expectedProfileId, fixture.aliceId);
    assert.equal(observed.sessionKey, session.key);
    assert.equal(observed.agentId, "qa");
    assert.equal(observed.runId, sent.runId);
    assert.equal(typeof observed.approvalId, "string");
    assert.equal(typeof observed.proposalHash, "string");
    approval.id = observed.approvalId;
    approval.hash = observed.proposalHash;
    assert.equal(typeof observed.requestId, "string");
    approval.requestID = observed.requestId;
    const matching = (await pendingApprovals(fixture)).filter(
      (item) =>
        isRecord(item.request) &&
        item.request.sessionKey === session.key &&
        item.request.agentId === "qa" &&
        item.request.runId === sent.runId,
    );
    assert.equal(matching.length, 1);
    assert.equal(matching[0]!.id, approval.id);
    assert(isRecord(matching[0]!.request));
    assert.equal(matching[0]!.request.proposalHash, approval.hash);
    const actual = await approvalSnapshot(fixture, approval.id!);
    sameApproval(actual, approval);
    assert.equal(actual.status, "pending");
    assert.deepEqual((actual.presentation as Record<string, unknown>).allowedDecisions, [
      "allow-once",
      "deny",
    ]);
    active.holding = true;
  };
  const requireReleasedApproval = () =>
    assertNativeUIApprovalReleased(approval, proxy.snapshot(), operatorConnection, fixture.aliceId);
  const forwardExpectation = (
    id: string,
    step: string,
  ): ["session" | "compose" | "inspect", "opened" | "cancelled" | "unavailable"] | undefined => {
    if (id === "sidebar-routing" || (id === "new-chat" && step === "bound-held")) {
      return ["inspect", "cancelled"];
    }
    if (step === "refused") {
      return ["session", "unavailable"];
    }
    if (step === "fresh-open") {
      return ["session", "opened"];
    }
    if (id === "run-controls" && ["open", "reopen", "gesture", "replace"].includes(step)) {
      return ["inspect", "opened"];
    }
    if (id === "native-projection") {
      return [step === "settings-inspect" ? "inspect" : "session", "opened"];
    }
    if (id === "new-chat" && step === "protected-editor") {
      return ["compose", "unavailable"];
    }
    return undefined;
  };
  const handle = async (input: unknown) => {
    assert(isRecord(input) && !stopping && !failed && !busy);
    busy = true;
    try {
      if (input.action === "onboarded") {
        assert(operatorConnection === undefined && !active && receipts.length === 0);
        const events = proxy.snapshot().events;
        const operators = events.filter(
          (row) =>
            row.kind === "connect-request" &&
            row.clientId === "openclaw-ios" &&
            row.role === "operator",
        );
        assert.equal(operators.length, 1, "Native operator bootstrap was ambiguous");
        const candidate = operators[0]!;
        assert.equal(candidate.operatorHandoffMatched, true);
        const hello = events.find(
          (row) => row.kind === "connect-success" && row.connection === candidate.connection,
        );
        assert.equal(hello?.authMethod, "trusted-proxy");
        assert(
          Array.isArray(hello.scopes) &&
            ["operator.admin", "operator.read", "operator.write"].every((scope) =>
              hello.scopes.includes(scope),
            ),
        );
        assert(
          events.some(
            (row) =>
              row.kind === "native-profile" &&
              row.connection === candidate.connection &&
              row.profileId === fixture.aliceId,
          ),
        );
        operatorConnection = candidate.connection;
        return {};
      }
      assert(operatorConnection !== undefined);
      if (input.action === "begin") {
        assert(!active && !approval);
        const next = roster[receipts.length];
        assert(next && input.id === next[0]);
        await proxyControl("reset");
        active = {
          id: next[0],
          steps: next[1],
          index: 0,
          phases: [],
          cursor: 0,
          forwards: 0,
          holding: false,
          forkKeys: [],
        };
        return {};
      }
      assert(active && input.id === active.id);
      if (input.action === "complete") {
        assert(active.index === active.steps.length && !active.baseline && !active.holding);
        if (approval) {
          requireReleasedApproval();
        }
        await settleApproval();
        if (approval) {
          requireReleasedApproval();
        }
        const sends = proxy
          .snapshot()
          .events.filter((row) => row.kind === "rpc-request" && row.method === "chat.send");
        assert.equal(sends.length, 0, "Rendered controls unexpectedly submitted a message");
        receipts.push({
          id: active.id,
          phases: [...active.phases],
          realControls: true,
          sends: 0,
          nativeForwards: active.forwards,
        });
        approval = undefined;
        active = undefined;
        return {};
      }
      assert.equal(
        input.step,
        active.steps[active.index],
        "Native UI subphases must execute exactly once in order",
      );
      const step = active.steps[active.index]!;
      if (input.action === "prepare") {
        assert(!active.baseline);
        active.baseline = readNativeUIObservation(input.observation);
        assert.equal(active.baseline.forwardingEntries, active.baseline.forwardingCompletions);
        active.cursor = proxy.snapshot().events.length;
        if (
          active.id === "sidebar-routing" ||
          (active.id === "new-chat" && step === "bound-held")
        ) {
          await proxyControl("hold-response", {
            method: "chat.history",
            selector: {
              expectedProfileId: fixture.aliceId,
              sessionKey: primary.key,
              inputRunId: primary.runID,
            },
          });
          active.holding = true;
        }
        if (active.id === "new-options-landscape" && step === "create-refused") {
          await proxyControl("reject-create", {
            selector: { expectedProfileId: fixture.aliceId, agentId: "qa" },
          });
        }
        if (active.id === "gateway-problem" && step === "node-fault") {
          await proxyControl("fail-node");
        }
        if (
          (active.id === "approval-dashboard" && step === "inbox") ||
          (active.id === "notification-guidance" && step === "approval-event")
        ) {
          await startApproval();
        }
        return {};
      }
      assert(active.baseline);
      if (input.action === "wait-held") {
        assert(active.holding);
        await proxyControl("wait-held");
        return {};
      }
      if (input.action === "release") {
        assert(active.holding && proxy.snapshot().heldResponse);
        await proxyControl("release-response");
        if (approval) {
          requireReleasedApproval();
        }
        active.holding = false;
        return {};
      }
      assert.equal(input.action, "observe");
      assert.equal(input.uiVerified, true);
      const after = readNativeUIObservation(input.observation);
      if (step === "refused") {
        assert.equal(active.baseline.idleUnprotectedComposer, true);
        assert.equal(after.idleUnprotectedComposer, true);
      }
      const expectation = forwardExpectation(active.id, step);
      if (expectation) {
        assertNativeUIForward(active.baseline, after, ...expectation);
        active.forwards += 1;
      } else {
        assert.equal(after.forwardingEntries, active.baseline.forwardingEntries);
        assert.equal(after.forwardingCompletions, active.baseline.forwardingCompletions);
      }
      const events = proxy.snapshot().events.slice(active.cursor);
      const resultFacts: Record<string, unknown> = {};
      if (active.id === "fork-session-controls" && ["fork", "fork-again"].includes(step)) {
        const result = events.filter((row) => row.kind === "fork-result");
        assert.equal(result.length, 1);
        const fork = result[0]!;
        const first = step === "fork";
        assert.equal(fork.ok, true);
        assert.equal(fork.sourceSessionKey, first ? primary.key : active.forkKeys[0]);
        assert.equal(fork.entryId, first ? primary.entryIDs[1] : primary.entryIDs[0]);
        assert.equal(
          fork.editorTextSHA256,
          createHash("sha256")
            .update(first ? primary.prompt : primary.priorPrompt!)
            .digest("hex"),
        );
        assert.equal(fork.attachmentCount, 1);
        assert.equal(fork.imageMimeType, "image/png");
        assert.equal(fork.imageBytes, Buffer.from(nativeVisualProofPNG, "base64").length);
        assert.equal(
          fork.imageSHA256,
          createHash("sha256").update(Buffer.from(nativeVisualProofPNG, "base64")).digest("hex"),
        );
        assert.equal(typeof fork.key, "string");
        assert(![primary.key, ...active.forkKeys].includes(fork.key));
        const described = await fixture.alice.request<{ session: { key: string } }>(
          "sessions.describe",
          { key: fork.key },
        );
        assert.equal(described.session.key, fork.key);
        const name = "Native UI " + kind + " fork " + (active.forkKeys.length + 1) + " " + suffix;
        await fixture.alice.request("sessions.patch", { key: fork.key, displayName: name });
        active.forkKeys.push(fork.key);
        resultFacts.createdName = name;
      }
      if (active.id === "fork-session-controls" && step === "reset") {
        const resets = events.filter(
          (row) => row.kind === "rpc-request" && row.method === "sessions.reset",
        );
        assert.equal(resets.length, 1);
        assert.equal(resets[0]!.key, active.forkKeys[1]);
        assert(
          events.some(
            (row) =>
              row.kind === "rpc-response" &&
              row.method === "sessions.reset" &&
              row.requestId === resets[0]!.requestId &&
              row.ok === true,
          ),
        );
      }
      assert(
        !events.some(
          (row) => row.kind === "rpc-request" && ["chat.send", "chat.abort"].includes(row.method),
        ),
      );
      if (active.id === "new-options-landscape" && step === "create-refused") {
        assert.equal(
          events.filter(
            (row) => row.kind === "controlled-request-refusal" && row.method === "sessions.create",
          ).length,
          1,
        );
        assert(!events.some((row) => row.kind === "mutation-success"));
      }
      if (active.id === "new-options-landscape" && step === "retry-created") {
        const created = events.filter((row) => row.kind === "mutation-success");
        assert.equal(created.length, 1);
        assert.equal(typeof created[0]!.key, "string");
        const described = await fixture.alice.request<{ session: { key: string } }>(
          "sessions.describe",
          { key: created[0]!.key },
        );
        assert.equal(described.session.key, created[0]!.key);
      }
      if (active.id === "gateway-problem" && step === "operator-current") {
        assert.equal(proxy.snapshot().connectedOperators, 1);
      }
      if (active.id === "gateway-problem" && step === "fresh-open") {
        assert.equal(proxy.snapshot().connectedOperators, 1);
        assert(
          events.some(
            (row) =>
              row.kind === "rpc-response" &&
              row.connection === operatorConnection &&
              row.method === "users.self" &&
              row.ok === true,
          ),
        );
        await proxyControl("release-node");
      }
      if (active.id === "notification-guidance" && step === "fresh-open") {
        assert(active.holding && proxy.snapshot().approval?.status === "held");
        await proxyControl("release-response");
        requireReleasedApproval();
        active.holding = false;
      }
      active.phases.push(step);
      active.index += 1;
      active.baseline = undefined;
      return resultFacts;
    } finally {
      busy = false;
    }
  };
  const server = createServer((request, response) => {
    const task = (async () => {
      assert(
        !stopping && tasks.size < 4 && request.method === "POST" && request.url === "/" + token,
      );
      let text = "";
      for await (const part of request) {
        text += String(part);
        assert(Buffer.byteLength(text) <= 4096);
      }
      const result = await handle(JSON.parse(text));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    })().catch(() => {
      if (!stopping) {
        failed = true;
      }
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end("native UI proof refused");
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  let shutdownTask: Promise<void> | undefined;
  let releaseTask: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;
  const closeAdmission = () => {
    if (!shutdownTask) {
      stopping = true;
      abort.abort();
      shutdownTask = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // Closing accepted HTTP bodies must precede joining their async iterators.
      server.closeAllConnections();
    }
    return shutdownTask;
  };
  return {
    primary,
    other,
    dashboard,
    controlURL: "http://127.0.0.1:" + address.port + "/" + token,
    receipts: () => receipts.map((receipt) => ({ ...receipt, phases: [...receipt.phases] })),
    verifyComplete() {
      assert(
        !failed &&
          !active &&
          !approval &&
          !stopping &&
          !busy &&
          tasks.size === 0 &&
          proxyCalls.size === 0,
      );
      assert.deepEqual(
        receipts.map((receipt) => receipt.id),
        roster.map(([id]) => id),
      );
    },
    releaseGates() {
      return (releaseTask ??= (async () => {
        const closed = closeAdmission();
        if (proxy.snapshot().heldResponse) {
          await proxyControl("release-response", {}, true);
        }
        await Promise.all([...tasks, ...proxyCalls, closed]);
        await settleApproval();
      })());
    },
    stop() {
      assert(stopping, "Release native UI producers before dependent teardown");
      return (stopTask ??= (async () => {
        await closeAdmission();
        await Promise.all([...tasks, ...proxyCalls]);
      })());
    },
  };
}
