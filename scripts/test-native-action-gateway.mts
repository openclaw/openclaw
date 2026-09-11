import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  startQaMockOpenAiServer,
  TINY_PNG_BASE64,
  type MockOpenAiRequestSnapshot,
} from "../extensions/qa-lab/api.js";
import {
  MODEL_REF,
  PROOF_TIMEOUT_MS,
  waitFor,
} from "../test/e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js";
import { wireMessageText } from "../test/e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js";
import { runProfileWireProof } from "../test/e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import {
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_WRITER_SCOPES,
} from "../test/e2e/qa-lab/runtime/skill-library-wire-fixture.js";
import { startQaGatewayRpcProxy } from "../test/fixtures/qa-gateway-rpc-proxy.mjs";
import type { OpenClawTestInstance } from "../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../test/helpers/qa-gateway-cleanup.js";
import { runManagedCommand } from "./lib/managed-child-process.mts";

const CASES = {
  allowed: "allowed",
  distinct: "allowed",
  foreign: "rejected",
  acl: "rejected",
  aclSuspended: "rejected",
  controlACL: "allowed",
  accepted: "allowed",
  profile: "rejected",
  profileSuspended: "rejected",
  controlProfile: "allowed",
} as const;
type CaseID = keyof typeof CASES;
type WireCase = { sessionKey: string; marker: string; message: string };
const MEDIA_CASES = {
  aclAllowed: { session: "acl", allowed: true },
  acl: { session: "acl", allowed: false },
  controlACL: { session: "controlACL", allowed: true },
  profileAllowed: { session: "profile", allowed: true },
  profile: { session: "profile", allowed: false },
  controlProfile: { session: "controlProfile", allowed: true },
  retiredResult: { session: "controlACL", allowed: false },
  retiredControl: { session: "controlACL", allowed: true },
} as const;
type MediaCaseID = keyof typeof MEDIA_CASES;
type MediaSession = (typeof MEDIA_CASES)[MediaCaseID]["session"];
type WireMedia = { sessionKey: string; artifactID: string };
// Native initial acquisition cannot borrow the unbound hello capability.
// Initial acquisition and recovery each need their own profile-bound refresh.
const IOS_WIDGET_CASES = {
  allowed: { allowed: true, requests: 2 },
  retiredResult: { allowed: false, requests: 1 },
  retiredLookup: { allowed: false, requests: 0 },
  retiredControl: { allowed: true, requests: 1 },
  profile: { allowed: false, requests: 1 },
  controlProfile: { allowed: true, requests: 1 },
} as const;
type IOSWidgetCaseID = keyof typeof IOS_WIDGET_CASES;
const SIGN_IN_SCOPES = [...SKILL_LIBRARY_WRITER_SCOPES, "operator.admin"];
const SIGN_IN_METHODS = [
  "models.authStatus",
  "models.authLogin",
  "wizard.next",
  "wizard.cancel",
  "wizard.status",
];
const SIGN_IN_START = [
  ["models.authStatus", true],
  ["models.authLogin", true],
  ["wizard.next", true],
  ["wizard.next", true],
] as const;
const SIGN_IN_CLOSE = [
  ["wizard.cancel", true],
  ["wizard.status", false],
] as const;
const SIGN_IN_CHECKPOINTS = {
  admitted: { entered: 1, settled: 0, responses: SIGN_IN_START },
  cleaned: { entered: 1, settled: 1, responses: SIGN_IN_CLOSE },
  denied: {
    entered: 1,
    settled: 1,
    responses: [
      ["models.authLogin", false],
      ["wizard.status", false],
    ],
  },
  profile: { entered: 2, settled: 2, responses: [...SIGN_IN_START, ...SIGN_IN_CLOSE] },
  replacement: { entered: 3, settled: 2, responses: SIGN_IN_START },
  retired: { entered: 3, settled: 2, responses: [] },
  complete: {
    entered: 3,
    settled: 3,
    responses: [["wizard.status", true], ...SIGN_IN_CLOSE],
  },
} as const;
type SignInCheckpoint = keyof typeof SIGN_IN_CHECKPOINTS;
const CONTROL_ACTIONS = [
  "pair",
  "revoke-acl",
  "merge-profile",
  "verify",
  "complete",
  "hold-response",
  "wait-held",
  "release-response",
  "media-start",
  "media-complete",
  "pair-signin",
  "signin-config",
  "signin-checkpoint",
  "widget-start",
  "widget-complete",
] as const;
type ControlProgress = {
  action: (typeof CONTROL_ACTIONS)[number] | "unknown";
  phase:
    | "body"
    | "action"
    | "connect-record"
    | "identity"
    | "pending-list"
    | "pending-match"
    | "approval"
    | "signin-order"
    | "signin-provider"
    | "signin-wire"
    | "signin-connection";
  signInCheckpoint?: SignInCheckpoint;
};
export type NativeActionFixtureDescriptor = {
  version: 1;
  gatewayURL: string;
  controlURL: string;
  controlToken: string;
  gatewayID: string;
  aliceProfileID: string;
  bobProfileID: string;
  cases: Record<CaseID, WireCase>;
  media: {
    pngBase64: string;
    sha256: string;
    sessions: Record<MediaSession, WireMedia>;
  };
};

async function readBody(request: AsyncIterable<Buffer | string>) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    assert(text.length <= 8192, "native fixture control body exceeded limit");
  }
  const input: unknown = JSON.parse(text);
  assert(isRecord(input), "native fixture control requires an object");
  return input;
}

/** No credentials are produced: the real provider runner waits for wizard cancellation. */
export async function startNativeActionProvider(includeSignIn = false) {
  const provider = await startQaMockOpenAiServer({ modelRefs: [MODEL_REF] });
  if (!includeSignIn) {
    return { ...provider, signIn: undefined };
  }
  const counts = { entered: 0, settled: 0 };
  let failed = false;
  const observer = createServer((request, response) => {
    request.resume();
    const phase =
      request.url === "/entered" ? "entered" : request.url === "/settled" ? "settled" : undefined;
    if (
      request.method !== "POST" ||
      !phase ||
      counts[phase] >= 8 ||
      (phase === "entered"
        ? counts.entered !== counts.settled
        : counts.settled + 1 !== counts.entered)
    ) {
      failed = true;
      response.writeHead(400).end();
      return;
    }
    counts[phase] += 1;
    response.writeHead(204).end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      observer.once("error", reject);
      observer.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await provider.stop();
    throw error;
  }
  const address = observer.address();
  assert(address && typeof address !== "string");
  const observerURL = `http://127.0.0.1:${address.port}`;
  const pluginId = "native-signin-proof";
  const signIn = {
    authChoice: `${pluginId}/prompt`,
    snapshot: () => {
      assert(!failed, "native sign-in observer rejected a transition");
      return { ...counts };
    },
    wait: async (phase: keyof typeof counts, count: number) => {
      await waitFor(`native sign-in ${phase}`, () => {
        assert(!failed && counts[phase] <= count, "unexpected native sign-in transition");
        return counts[phase] === count ? true : undefined;
      });
    },
    prepare: async (instance: OpenClawTestInstance, config: OpenClawConfig) => {
      const pluginDir = path.join(instance.homeDir, "native-signin-plugin");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          activation: { onStartup: true, onProviders: [pluginId] },
          providers: [pluginId],
          providerAuthChoices: [
            {
              provider: pluginId,
              method: "prompt",
              choiceId: "prompt",
              choiceLabel: "Native sign-in proof",
              credentialOnly: true,
              appGuidedAuth: "device-code",
            },
          ],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "index.mjs"),
        [
          `const report = async (phase) => {`,
          `  const response = await fetch(${JSON.stringify(observerURL)} + "/" + phase, {`,
          '    method: "POST", signal: AbortSignal.timeout(5000),',
          "  });",
          '  if (!response.ok) throw new Error("Native sign-in observer rejected a transition.");',
          "};",
          "export default {",
          `  id: ${JSON.stringify(pluginId)},`,
          "  register(api) {",
          "    api.registerProvider({",
          `      id: ${JSON.stringify(pluginId)}, label: "Native sign-in proof",`,
          "      auth: [{",
          '        id: "prompt", label: "Native sign-in proof", kind: "device_code",',
          "        async run(context) {",
          '          await report("entered");',
          "          try {",
          '            await context.prompter.text({ message: "Native sign-in cancellation proof" });',
          '            throw new Error("The native proof prompt must be cancelled.");',
          "          } finally {",
          '            await report("settled");',
          "          }",
          "        },",
          "      }],",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      );
      config.plugins = {
        ...config.plugins,
        enabled: true,
        allow: [...(config.plugins?.allow ?? []), pluginId],
        load: {
          ...config.plugins?.load,
          paths: [...(config.plugins?.load?.paths ?? []), pluginDir],
        },
        entries: { ...config.plugins?.entries, [pluginId]: { enabled: true } },
      };
    },
  };
  return {
    ...provider,
    signIn,
    // runProfileWireProof stops the provider after the Gateway and its owned runners.
    stop: () =>
      runQaGatewayFixture(
        () => provider.stop(),
        async () => {
          await new Promise<void>((resolve, reject) => {
            observer.close((error) => (error ? reject(error) : resolve()));
            observer.closeAllConnections();
          });
        },
      ),
  };
}

/** Fixture lifecycle is reusable by native consumers without importing a test runner. */
export async function withNativeActionGateway(
  platform: "ios" | "macos",
  executeNative: (descriptor: NativeActionFixtureDescriptor) => Promise<void>,
) {
  let completedCases: CaseID[] = [];
  let completedMedia: MediaCaseID[] = [];
  let completedWidgets: IOSWidgetCaseID[] = [];
  let signInSnapshot: (() => { entered: number; settled: number }) | undefined;
  let signInVerified = false;
  await runProfileWireProof(
    () => startNativeActionProvider(platform === "ios"),
    async (fixture) => {
      const { instance, provider, admin, alice, bob, aliceId, bobId } = fixture;
      const controlToken = randomUUID();
      const mediaPaths = new Set<string>();
      const proxy = await startQaGatewayRpcProxy({
        backendPort: instance.port,
        repoRoot: process.cwd(),
        token: controlToken,
        recordPath: undefined,
        observedMethods: ["artifacts.download", "plugin.surface.refresh"],
        mediaPaths,
        upstreamHeaders: {
          "x-forwarded-user": SKILL_LIBRARY_ALICE,
          "x-forwarded-for": "198.51.100.40",
          "x-forwarded-proto": "http",
          "x-forwarded-host": `127.0.0.1:${instance.port}`,
          "x-openclaw-scopes": SKILL_LIBRARY_WRITER_SCOPES.join(","),
        },
      });
      const verified = new Map<CaseID, string | undefined>();
      const completed = new Set<CaseID>();
      const mediaCompleted = new Set<MediaCaseID>();
      let mediaAttempt: { id: MediaCaseID; before: ReturnType<typeof proxy.snapshot> } | undefined;
      const widgetsCompleted = new Map<
        IOSWidgetCaseID,
        ReturnType<typeof proxy.snapshot>["events"]
      >();
      let widgetAttempt:
        | { id: IOSWidgetCaseID; before: ReturnType<typeof proxy.snapshot> }
        | undefined;
      const png = Buffer.from(TINY_PNG_BASE64, "base64");
      const media = {
        pngBase64: TINY_PNG_BASE64,
        sha256: createHash("sha256").update(png).digest("hex"),
        sessions: {} as Record<MediaSession, WireMedia>,
      };
      let signInProxy: Awaited<ReturnType<typeof startQaGatewayRpcProxy>> | undefined;
      const signInCheckpoints: SignInCheckpoint[] = [];
      let signInEventIndex = 0;
      let signInConnection: number | undefined;
      const pairedDevices = new Set<string>();
      const pending = new Set<Promise<void>>();
      let firstControlFailure: Error | undefined;
      const cases = {} as Record<CaseID, WireCase>;
      const commands = new Map<CaseID, { sentinel: string; command: string }>();
      const caseKeys = Object.keys(CASES) as CaseID[];
      const groups = new Map<string, string>();
      const journal = async (): Promise<MockOpenAiRequestSnapshot[]> => {
        const response = await fetch(`${provider.baseUrl}/debug/requests?after=0`, {
          signal: AbortSignal.timeout(30_000),
        });
        assert(response.ok);
        return (await response.json()) as MockOpenAiRequestSnapshot[];
      };
      const history = async (sessionKey: string) =>
        (
          await admin.request<{ messages: Array<{ role?: string; content?: unknown }> }>(
            "chat.history",
            { sessionKey, limit: 100 },
          )
        ).messages;
      const verify = async (id: CaseID, runId?: string) => {
        const spec = cases[id];
        const effects = commands.get(id)!;
        if (CASES[id] === "allowed") {
          assert(runId, `missing native run receipt for ${id}`);
          const terminal = await admin.request<{ status: string }>(
            "agent.wait",
            { runId, timeoutMs: PROOF_TIMEOUT_MS },
            PROOF_TIMEOUT_MS + 5000,
          );
          assert.equal(terminal.status, "ok");
          await waitFor(`native ${id} final transcript`, async () => {
            const messages = await history(spec.sessionKey);
            return messages.some(
              (message) => message.role === "assistant" && wireMessageText(message) === spec.marker,
            )
              ? true
              : undefined;
          });
        }
        const messages = await history(spec.sessionKey);
        const requests = await journal();
        const expectedCount = CASES[id] === "allowed" ? 1 : 0;
        assert.equal(
          messages.filter(
            (message) => message.role === "user" && wireMessageText(message).includes(spec.marker),
          ).length,
          expectedCount,
          `${id}: user admission count`,
        );
        assert.equal(
          requests.filter(
            (request) =>
              request.requestKind === "agent-initial" &&
              request.plannedToolName === "exec" &&
              request.plannedToolArgs?.command === effects.command,
          ).length,
          expectedCount,
          `${id}: provider turn count`,
        );
        assert.equal(
          await fs.readFile(effects.sentinel, "utf8"),
          CASES[id] === "allowed" ? spec.marker : "",
          `${id}: executable sentinel count`,
        );
        if (CASES[id] === "rejected") {
          assert(!requests.some((request) => request.raw.includes(spec.marker)));
        }
        if (verified.has(id)) {
          assert.equal(verified.get(id), runId, `${id}: replay changed its receipt`);
        }
        verified.set(id, runId);
      };
      const proxyControl = async (input: Record<string, unknown>) => {
        const response = await fetch(proxy.controlUrl, {
          method: "POST",
          headers: { "x-qa-fixture-token": controlToken },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(35_000),
        });
        assert(response.ok, "proxy control failed");
        return await response.json();
      };
      const handle = async (
        input: Record<string, unknown>,
        progress: ControlProgress,
      ): Promise<unknown> => {
        progress.action = CONTROL_ACTIONS.find((action) => action === input.action) ?? "unknown";
        progress.phase = "action";
        if (["hold-response", "wait-held", "release-response"].includes(String(input.action))) {
          return await proxyControl(input);
        }
        switch (input.action) {
          case "signin-config":
            assert(signInProxy && provider.signIn && signInCheckpoints.length === 0);
            return {
              signInGatewayURL: signInProxy.url,
              signInAuthChoice: provider.signIn.authChoice,
            };
          case "signin-checkpoint": {
            progress.phase = "signin-order";
            assert(signInProxy && provider.signIn);
            const checkpoint = Object.keys(SIGN_IN_CHECKPOINTS)[signInCheckpoints.length];
            assert(checkpoint && input.checkpoint === checkpoint);
            const id = checkpoint as SignInCheckpoint;
            progress.signInCheckpoint = id;
            const spec = SIGN_IN_CHECKPOINTS[id];
            progress.phase = "signin-provider";
            assert.deepEqual(provider.signIn.snapshot(), {
              entered: spec.entered,
              settled: spec.settled,
            });
            progress.phase = "signin-wire";
            const snapshot = signInProxy.snapshot();
            const events = snapshot.events.slice(signInEventIndex);
            const requests = events.filter(
              (event: { kind: string }) => event.kind === "rpc-request",
            );
            const responses = events.filter(
              (event: { kind: string }) => event.kind === "rpc-response",
            );
            assert.deepEqual(
              requests.map((event: { method: string }) => event.method),
              spec.responses.map(([method]) => method),
            );
            assert.deepEqual(
              responses.map((event: { method: string; ok: boolean }) => [event.method, event.ok]),
              spec.responses,
            );
            progress.phase = "signin-connection";
            if (id === "admitted" || id === "replacement") {
              const connection = requests[0]!.connection;
              assert.notEqual(connection, signInConnection);
              signInConnection = connection;
            }
            for (const [index, request] of requests.entries()) {
              assert.equal(request.connection, signInConnection);
              assert.equal(responses[index]!.connection, signInConnection);
              assert.equal(responses[index]!.requestId, request.requestId);
            }
            signInEventIndex = snapshot.events.length;
            signInCheckpoints.push(id);
            return { completed: id };
          }
          case "widget-start": {
            assert(platform === "ios");
            assert(typeof input.case === "string" && Object.hasOwn(IOS_WIDGET_CASES, input.case));
            const id = input.case as IOSWidgetCaseID;
            assert(
              !widgetAttempt && !widgetsCompleted.has(id),
              "overlapping or repeated widget case",
            );
            const before = proxy.snapshot();
            const admission = before.events.findLast(
              (event: { kind: string }) => event.kind === "connect-success",
            );
            assert(
              typeof admission?.canvasOrigin === "string",
              "native hello omitted canvas authority",
            );
            widgetAttempt = { id, before };
            return { started: id, canvasOrigin: admission.canvasOrigin };
          }
          case "widget-complete": {
            assert(widgetAttempt && widgetAttempt.id === input.case, "widget case was not started");
            const { id, before } = widgetAttempt;
            assert.equal(input.outcome, IOS_WIDGET_CASES[id].allowed ? "allowed" : "rejected");
            widgetsCompleted.set(id, proxy.snapshot().events.slice(before.events.length));
            widgetAttempt = undefined;
            return { completed: id };
          }
          case "media-start": {
            assert(typeof input.case === "string" && Object.hasOwn(MEDIA_CASES, input.case));
            const id = input.case as MediaCaseID;
            assert(!mediaAttempt && !mediaCompleted.has(id), "overlapping or repeated media case");
            mediaAttempt = { id, before: proxy.snapshot() };
            return { started: id };
          }
          case "media-complete": {
            assert(mediaAttempt && mediaAttempt.id === input.case, "media case was not started");
            const { id, before } = mediaAttempt;
            const allowed = MEDIA_CASES[id].allowed;
            const after = proxy.snapshot();
            const expected = allowed || id === "retiredResult" ? 1 : 0;
            for (const counter of ["requests", "matched", "completed", "succeeded"] as const) {
              assert.equal(
                after.media[counter] - before.media[counter],
                expected,
                `${id}: media ${counter}`,
              );
            }
            const responses = after.events
              .slice(before.events.length)
              .filter(
                (event: { kind: string; method?: string }) =>
                  event.kind === "rpc-response" && event.method === "artifacts.download",
              );
            assert.equal(responses.length, 1, `${id}: fresh artifact authorization response`);
            assert.equal(responses[0].ok, expected === 1, `${id}: artifact authorization`);
            if (id === "retiredResult") {
              const held = after.events
                .slice(before.events.length)
                .find(
                  (event: { kind: string; method?: string }) =>
                    event.kind === "response-held" && event.method === "media.get",
                );
              assert(held?.ok && held.sha256 === media.sha256 && held.sizeBytes === png.length);
              assert(
                after.events
                  .slice(before.events.length)
                  .some(
                    (event: { kind: string; method?: string; delivered?: boolean }) =>
                      event.kind === "response-released" &&
                      event.method === "media.get" &&
                      event.delivered,
                  ),
                "held PNG was not released to the retired loader",
              );
            }
            assert.equal(input.outcome, allowed ? "allowed" : "rejected");
            assert.equal(input.sha256, allowed ? media.sha256 : undefined);
            mediaCompleted.add(id);
            mediaAttempt = undefined;
            return { completed: id };
          }
          case "pair":
          case "pair-signin": {
            progress.phase = "connect-record";
            const pairingProxy = input.action === "pair" ? proxy : signInProxy;
            assert(pairingProxy);
            const connection = pairingProxy
              .snapshot()
              .events.findLast((event: { kind: string }) => event.kind === "connect-request");
            assert(connection, "native connect record was missing");
            progress.phase = "identity";
            assert.equal(connection.clientId, `openclaw-${platform}`);
            assert.equal(typeof connection.deviceId, "string");
            assert(connection.deviceId.length > 0, "native device identity was omitted");
            progress.phase = "pending-list";
            const list = await admin.request<{
              pending: Array<{ requestId: string; deviceId: string }>;
            }>("device.pair.list", {});
            progress.phase = "pending-match";
            const request = list.pending.find((entry) => entry.deviceId === connection.deviceId);
            assert(request, "native device did not enter real pairing");
            progress.phase = "approval";
            await admin.request("device.pair.approve", { requestId: request.requestId });
            pairedDevices.add(connection.deviceId);
            return { paired: true };
          }
          case "revoke-acl": {
            // Bob created this session. A real owner-only draft removes Alice's writer access.
            const result = await bob.request<{ visibility: string }>("session.visibility.set", {
              sessionKey: cases.acl.sessionKey,
              visibility: "draft",
            });
            assert.equal(result.visibility, "draft");
            await assert.rejects(
              alice.request("chat.history", { sessionKey: cases.acl.sessionKey, limit: 1 }),
            );
            return { revoked: true };
          }
          case "merge-profile":
            if (platform === "ios") {
              assert.deepEqual(signInCheckpoints, ["admitted"]);
              assert.deepEqual(provider.signIn?.snapshot(), { entered: 1, settled: 0 });
            }
            await admin.request("users.linkEmail", {
              email: SKILL_LIBRARY_ALICE,
              targetProfileId: bobId,
            });
            assert.equal(
              (await alice.request<{ profile: { id: string } }>("users.self", {})).profile.id,
              bobId,
            );
            return { profileID: bobId };
          case "verify": {
            assert(typeof input.case === "string" && Object.hasOwn(CASES, input.case));
            const id = input.case as CaseID;
            assert.equal(input.outcome, CASES[id]);
            assert(input.runId === undefined || typeof input.runId === "string");
            await verify(id, input.runId);
            return { verified: id };
          }
          case "complete":
            assert(typeof input.case === "string" && verified.has(input.case as CaseID));
            assert(!completed.has(input.case as CaseID), "duplicate native case completion");
            completed.add(input.case as CaseID);
            return { completed: input.case };
          default:
            throw new Error("unknown native fixture action");
        }
      };
      const control = createServer((request, response) => {
        const progress: ControlProgress = { action: "unknown", phase: "body" };
        const task = (async () => {
          if (
            request.method !== "POST" ||
            request.url !== "/" ||
            request.headers["x-qa-fixture-token"] !== controlToken
          ) {
            response.writeHead(403).end();
            return;
          }
          const result = await handle(await readBody(request), progress);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        })().catch((error: unknown) => {
          if (!firstControlFailure) {
            const category =
              error instanceof assert.AssertionError
                ? "assertion"
                : error instanceof Error
                  ? "error"
                  : "non-error";
            const connectionTrace =
              progress.action === "pair"
                ? `; firstConnection=${JSON.stringify(proxy.snapshot().firstConnection)}`
                : "";
            const message =
              `native fixture controls failed: action=${progress.action}; phase=${progress.phase}; reason=request-failed; category=${category}` +
              (progress.signInCheckpoint ? `; signInCheckpoint=${progress.signInCheckpoint}` : "") +
              connectionTrace;
            // Raw assertions and stacks can contain fixture credentials and private paths.
            firstControlFailure = new Error(message);
            firstControlFailure.stack = message;
          }
          response.writeHead(500).end("native fixture assertion failed");
        });
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task),
        );
      });
      await runQaGatewayFixture(
        async () => {
          for (const id of caseKeys) {
            const group =
              id === "aclSuspended" ? "acl" : id === "profileSuspended" ? "profile" : id;
            let sessionKey = groups.get(group);
            if (!sessionKey) {
              sessionKey = await fixture.createSession(
                `native-${platform}-${group.toLowerCase()}`,
                "bob",
              );
              groups.set(group, sessionKey);
            }
            const marker = `NATIVE-${platform.toUpperCase()}-${id.toUpperCase()}`;
            const sentinel = path.join(instance.state.workspaceDir, `${marker}.txt`);
            const command = `printf '%s' ${JSON.stringify(marker)} >> ${JSON.stringify(`./${marker}.txt`)}`;
            await fs.writeFile(sentinel, "");
            commands.set(id, { sentinel, command });
            cases[id] = {
              sessionKey,
              marker,
              message: [
                "Tool progress QA check.",
                `Call the exec tool exactly once with this exact command before answering: \`${command}\`.`,
                `Reply exactly \`${marker}\`.`,
              ].join(" "),
            };
          }
          // Bob's ordinary send ingests the PNG into managed media. Native clients
          // receive only the artifact id and must obtain their own authorized download.
          await fs.writeFile(path.join(instance.state.workspaceDir, "native-wire.png"), png);
          for (const session of new Set(Object.values(MEDIA_CASES).map((spec) => spec.session))) {
            const sessionKey = cases[session].sessionKey;
            const started = await bob.request<{ runId: string }>("chat.send", {
              sessionKey,
              message: "Reply exactly `MEDIA:./native-wire.png`",
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            const terminal = await admin.request<{ status: string }>(
              "agent.wait",
              { runId: started.runId, timeoutMs: PROOF_TIMEOUT_MS },
              PROOF_TIMEOUT_MS + 5000,
            );
            assert.equal(terminal.status, "ok", "media ingestion run failed");
            const artifacts = await waitFor("managed native PNG", async () => {
              const result = await bob.request<{
                artifacts: Array<{ id: string; mimeType?: string; download: { mode: string } }>;
              }>("artifacts.list", { sessionKey, agentId: "qa" });
              return result.artifacts.length > 0 ? result.artifacts : undefined;
            });
            assert.equal(artifacts.length, 1);
            const artifact = artifacts[0]!;
            assert.match(artifact.id, /^artifact_managed_image_/);
            assert.equal(artifact.mimeType, "image/png");
            assert.equal(artifact.download.mode, "url");
            const download = await bob.request<{ url: string }>("artifacts.download", {
              sessionKey,
              agentId: "qa",
              artifactId: artifact.id,
            });
            assert(download.url.startsWith("/api/chat/media/outgoing/"));
            mediaPaths.add(new URL(download.url, "http://127.0.0.1").pathname);
            media.sessions[session] = { sessionKey, artifactID: artifact.id };
          }
          if (platform === "ios") {
            assert(provider.signIn);
            signInSnapshot = provider.signIn.snapshot;
            signInProxy = await startQaGatewayRpcProxy({
              backendPort: instance.port,
              repoRoot: process.cwd(),
              token: controlToken,
              recordPath: undefined,
              observedMethods: SIGN_IN_METHODS,
              upstreamHeaders: {
                "x-forwarded-user": SKILL_LIBRARY_ALICE,
                "x-forwarded-for": "198.51.100.40",
                "x-forwarded-proto": "http",
                "x-forwarded-host": `127.0.0.1:${instance.port}`,
                "x-openclaw-scopes": SIGN_IN_SCOPES.join(","),
              },
            });
          }
          await new Promise<void>((resolve, reject) => {
            control.once("error", reject);
            control.listen(0, "127.0.0.1", resolve);
          });
          const address = control.address();
          assert(address && typeof address !== "string");
          try {
            await executeNative({
              version: 1,
              gatewayURL: proxy.url,
              controlURL: `http://127.0.0.1:${address.port}/`,
              controlToken,
              gatewayID: `native-action-${randomUUID()}`,
              aliceProfileID: aliceId,
              bobProfileID: bobId,
              cases,
              media,
            });
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "native-child-failed",
                platform,
                completedCases: completed.size,
                completedMedia: mediaCompleted.size,
                completedWidgets: widgetsCompleted.size,
                lastSignInCheckpoint: signInCheckpoints.at(-1) ?? "none",
              }),
            );
            throw error;
          }
          assert.deepEqual(
            [...completed].toSorted(),
            [...caseKeys].toSorted(),
            "missing native wire cases",
          );
          if (platform === "ios") {
            assert(signInProxy);
            assert.deepEqual(signInCheckpoints, Object.keys(SIGN_IN_CHECKPOINTS));
            assert.deepEqual(provider.signIn?.snapshot(), { entered: 3, settled: 3 });
            const events = signInProxy.snapshot().events;
            assert(
              !events
                .slice(signInEventIndex)
                .some((event: { kind: string }) => event.kind.startsWith("rpc-")),
              "native sign-in sent RPCs after completion",
            );
            const connections = events.filter(
              (event: { kind: string }) => event.kind === "connect-request",
            );
            assert(connections.length >= 2);
            const writer = proxy
              .snapshot()
              .events.find((event: { kind: string }) => event.kind === "connect-request");
            for (const connection of connections) {
              assert.equal(connection.clientId, "openclaw-ios");
              assert.equal(connection.deviceId, writer?.deviceId);
              assert(pairedDevices.has(connection.deviceId));
            }
            const admissions = events.filter(
              (event: { kind: string }) => event.kind === "connect-success",
            );
            assert.equal(admissions.length, 2);
            for (const admission of admissions) {
              assert.deepEqual(admission.scopes.toSorted(), SIGN_IN_SCOPES.toSorted());
            }
            signInVerified = true;
          }
          if (platform === "ios") {
            assert.deepEqual([...mediaCompleted].toSorted(), Object.keys(MEDIA_CASES).toSorted());
            assert(!mediaAttempt, "unfinished native media case");
            assert.deepEqual(
              [...widgetsCompleted.keys()].toSorted(),
              Object.keys(IOS_WIDGET_CASES).toSorted(),
            );
            assert(!widgetAttempt, "unfinished native widget case");
            for (const [id, events] of widgetsCompleted) {
              const spec = IOS_WIDGET_CASES[id];
              const requests = events.filter(
                (event: { kind: string; method?: string }) =>
                  event.kind === "rpc-request" && event.method === "plugin.surface.refresh",
              );
              const responses = events.filter(
                (event: { kind: string; method?: string }) =>
                  event.kind === "rpc-response" && event.method === "plugin.surface.refresh",
              );
              assert.equal(requests.length, spec.requests, `${id}: widget request count`);
              assert.equal(responses.length, spec.requests, `${id}: widget response count`);
              for (const [index, request] of requests.entries()) {
                assert.equal(request.surface, "canvas");
                assert.equal(request.expectedProfileId, id === "controlProfile" ? bobId : aliceId);
                const response = responses[index]!;
                assert.equal(response.requestId, request.requestId);
                assert.equal(response.connection, request.connection);
                assert.equal(response.ok, id !== "profile", `${id}: widget authorization`);
                assert.equal(
                  response.reason,
                  id === "profile" ? "EXPECTED_PROFILE_MISMATCH" : undefined,
                );
              }
              if (id === "retiredResult") {
                const held = events.find(
                  (event: { kind: string; method?: string }) =>
                    event.kind === "response-held" && event.method === "plugin.surface.refresh",
                );
                const successor = events.find(
                  (event: { kind: string }) => event.kind === "connect-success",
                );
                const released = events.find(
                  (event: { kind: string; method?: string }) =>
                    event.kind === "response-released" && event.method === "plugin.surface.refresh",
                );
                assert(
                  held?.ok && successor && released,
                  "missing held refresh retirement barrier",
                );
                assert.equal(held.connection, requests[0]!.connection);
                assert.notEqual(successor.connection, held.connection);
                assert(
                  held.sequence < successor.sequence && successor.sequence < released.sequence,
                );
                assert.equal(released.delivered, false, "retired socket received held refresh");
                assert(
                  !requests.some(
                    (request: { connection: number }) =>
                      request.connection === successor.connection,
                  ),
                );
              }
            }
          }
          assert(pairedDevices.size > 0, "no real native device pairing was approved");
          for (const request of proxy
            .snapshot()
            .events.filter((event: { kind: string }) => event.kind === "connect-request")) {
            assert.equal(request.clientId, `openclaw-${platform}`);
            assert(
              pairedDevices.has(request.deviceId),
              "native connection bypassed paired identity",
            );
          }
          const admissions = proxy
            .snapshot()
            .events.filter((event: { kind: string }) => event.kind === "connect-success");
          assert(admissions.length > 0, "no real native admission");
          for (const admission of admissions) {
            assert.deepEqual(
              admission.scopes.toSorted(),
              [...SKILL_LIBRARY_WRITER_SCOPES].toSorted(),
              "native authority escaped the proxy's nonadmin cap",
            );
          }
          for (const [id, runId] of verified) {
            await verify(id, runId);
          }
        },
        () => signInProxy?.stop(),
        () => proxy.stop(),
        async () => {
          control.closeAllConnections();
          if (control.listening) {
            await new Promise<void>((resolve, reject) => {
              control.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
        async () => {
          await Promise.allSettled(pending);
        },
        () => {
          if (firstControlFailure) {
            throw firstControlFailure;
          }
        },
      );
      completedCases = [...completed];
      completedMedia = [...mediaCompleted];
      completedWidgets = [...widgetsCompleted.keys()];
    },
    async ({ instance, provider, config }) => {
      await provider.signIn?.prepare(instance, config);
    },
  );
  if (platform === "ios") {
    assert(signInVerified);
    assert.deepEqual(signInSnapshot?.(), { entered: 3, settled: 3 });
  }
  console.log(
    JSON.stringify({
      platform,
      cases: completedCases,
      mediaCases: completedMedia,
      widgetCases: completedWidgets,
      ...(platform === "ios"
        ? { signInCases: ["admittedCleanup", "retiredProfile", "retiredRoute"] }
        : {}),
      finalEffectsVerified: true,
    }),
  );
}

async function runNative(platform: "ios" | "macos", fixture: NativeActionFixtureDescriptor) {
  const descriptor = JSON.stringify(fixture);
  if (platform === "macos") {
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "scripts/test-macos-native.mts",
        "default",
        "--native-action-fixture",
        descriptor,
        "--package-path",
        "apps/macos",
        "--build-system",
        "native",
        "--skip-build",
        "--filter",
        "NativeActionGatewayWireTests",
      ],
      timeoutMs: 20 * 60_000,
      requireProcessTreeExit: true,
    });
    assert.equal(code, 0, "native macOS wire suite failed");
    return;
  }
  let simulatorJSON = "";
  const listCode = await runManagedCommand({
    bin: "xcrun",
    args: ["simctl", "list", "devices", "available", "--json"],
    stdio: ["ignore", "pipe", "inherit"],
    timeoutMs: 30_000,
    requireProcessTreeExit: true,
    onReady: (child) =>
      child.stdout?.on("data", (chunk) => {
        simulatorJSON += String(chunk);
        assert(simulatorJSON.length < 1024 * 1024, "simulator inventory too large");
      }),
  });
  assert.equal(listCode, 0);
  const inventory = JSON.parse(simulatorJSON) as {
    devices: Record<string, Array<{ name: string; isAvailable: boolean; udid: string }>>;
  };
  const simulator = Object.values(inventory.devices)
    .flat()
    .find((device) => device.isAvailable && device.name.startsWith("iPhone"));
  assert(simulator, "no available iPhone simulator");
  const code = await runManagedCommand({
    bin: "xcodebuild",
    args: [
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClaw",
      "-configuration",
      "Debug",
      "-destination",
      `platform=iOS Simulator,id=${simulator.udid}`,
      "-parallel-testing-enabled",
      "NO",
      "-only-testing:OpenClawTests/NativeActionGatewayWireTests",
      "test",
    ],
    env: { ...process.env, TEST_RUNNER_OPENCLAW_NATIVE_ACTION_FIXTURE: descriptor },
    timeoutMs: 45 * 60_000,
    requireProcessTreeExit: true,
  });
  assert.equal(code, 0, "native iOS wire suite failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const platform = process.argv[2];
  assert(platform === "ios" || platform === "macos", "select ios or macos");
  assert(
    process.platform === "darwin" &&
      process.env.CI === "true" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_OS === "macOS",
    "native wire proof requires the disposable hosted Apple CI worker",
  );
  await withNativeActionGateway(platform, (fixture) => runNative(platform, fixture));
}
