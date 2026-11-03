import { expect, it, onTestFinished, vi } from "vitest";
import { createApplicationConfigCapability } from "../../../../ui/src/app/config.ts";
import type { ApplicationContext } from "../../../../ui/src/app/context.ts";
import { formatUiError } from "../../../../ui/src/lib/format-error.ts";
import { t } from "../../../../ui/src/lib/reactive/i18n.ts";
import { createSessionCapability } from "../../../../ui/src/lib/sessions/index.ts";
import { sessionsResult } from "../../../../ui/src/lib/sessions/session-capability.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "../../../../ui/src/pages/chat/chat-application-context.test-support.ts";
import { createRenderTestChatPane } from "../../../../ui/src/pages/chat/chat-pane.test-support.ts";
import { createApplicationGateway } from "../../../../ui/src/test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../../ui/src/test-helpers/gateway-methods.ts";
import { installRepositoryPresentation } from "../../../../ui/src/test-helpers/repository-presentation.test-support.ts";
import { createPublicationPresentation, createGitHubPublicationOperationFactory } from "../api.ts";
import {
  account,
  confirmation,
  generation,
  options as publicationOptions,
  requestId,
  shared,
} from "./chat-github-publication.test-support.ts";

/* @vitest-environment jsdom */

function createPublicationPane(
  scope?: "global" | "per-sender",
  operatorScopes = ["operator.read", "operator.write"],
) {
  const agentId = scope ? "research" : "main";
  const sessionKey = scope ? "global" : "agent:main:publication";
  const options = { ...publicationOptions };
  const responses = new Map<string, unknown>([
    ["projects.list", { projects: [] }],
    ["sessions.github.options", options],
    ["sessions.github.publish", new Error("Response lost")],
  ]);
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (!responses.has(method)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    const response = responses.get(method);
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  const client = createGatewayBrowserClientFixture({ request });
  const initial = createInitializationContext();
  const hello = gatewayHelloForMethods(
    ["sessions.github.publish", "sessions.github.options", "projects.list"],
    operatorScopes,
  );
  if (scope) {
    hello.snapshot = {
      sessionDefaults: {
        defaultAgentId: "ops",
        mainKey: "main",
        mainSessionKey: scope === "global" ? "global" : "agent:ops:main",
      },
    };
  }
  const events = createApplicationGateway({
    ...initial.gateway.snapshot,
    client,
    phase: "connected",
    hello,
    assistantAgentId: agentId,
    sessionKey,
    selfUser: { id: "publication-person", identity: { type: "profile", id: "publication-person" } },
  });
  const gateway = { ...initial.gateway, ...events.gateway, connection: initial.gateway.connection };
  const selection = {
    ...initial.agentSelection,
    state: { selectedId: agentId, scopeId: agentId },
    subscribe: () => () => {},
  };
  const context: ApplicationContext = {
    ...initial,
    config: createApplicationConfigCapability({ resourceBasePath: "" }),
    gateway,
    agentSelection: selection,
    sessions: createSessionCapability(gateway, selection),
  };
  const pane = Object.assign(createRenderTestChatPane(), {
    publicationView: () => {
      publication.sync();
      return publication.view();
    },
  });
  const abort = new AbortController();
  const activation = installRepositoryPresentation(context);
  const publication = createPublicationPresentation(
    activation.host,
    () => ({
      props: { sessionKey: state.sessionKey, agentId, facts: pane.chatProps?.sessionHeaderFacts },
      presented: pane.presented,
      signal: abort.signal,
    }),
    () => {},
    createGitHubPublicationOperationFactory(
      formatUiError,
      () => t("githubPublication.capacity", { newAction: t("githubPublication.newAction") }),
      activation.host.sessions.artifactKey,
    ),
  );
  Object.defineProperties(pane, {
    isConnected: { configurable: true, value: true },
    connectedClient: { configurable: true, value: client, writable: true },
  });
  const state = pane.initialize(context);
  onTestFinished(() => {
    pane.presented = false;
    publication.dispose();
    abort.abort();
    context.sessions.dispose();
  });
  state.client = client;
  state.connected = true;
  state.sessionKey = sessionKey;
  state.assistantAgentId = agentId;
  state.sessionsResultAgentId = agentId;
  state.sessionsResult = {
    // Scoped lists may carry the owner only at the result/route level.
    ...sessionsResult([
      {
        key: sessionKey,
        sessionId: "publication",
        worktree: {
          id: "worktree-publication",
          branch: "feature/publication",
          repoRoot: "/synthetic/repository",
        },
        kind: scope ? "global" : "direct",
        updatedAt: 1,
      },
    ]),
    path: "",
  };
  const settled = async () => {
    await vi.waitFor(() => {
      pane.render();
      expect(pane.publicationView()?.activity).toBeNull();
    });
    return pane.publicationView()!;
  };
  const emitGatewayEvent = (event: string, payload: unknown) => {
    events.publishEvent({ type: "event", event, payload });
  };
  const publications = () =>
    request.mock.calls.filter(([method]) => method === "sessions.github.publish");
  return {
    pane,
    state,
    context,
    request,
    options,
    responses,
    publications,
    settled,
    emitGatewayEvent,
    present(next: boolean) {
      pane.presented = next;
      publication.sync();
    },
  };
}

it.each(["global", "per-sender"] as const)(
  "preserves the selected raw-global owner through publication RPCs in %s scope",
  async (scope) => {
    const { pane, request, responses, settled } = createPublicationPane(scope);
    responses.delete("projects.list");
    const result = {
      requestId,
      publisher: { source: "personal", ...account },
      status: "needs_confirmation",
    };
    responses.set("sessions.github.publish", result);
    responses.set("sessions.github.status", { result, confirmation });
    responses.set("sessions.github.confirm", { ...result, status: "published" });
    (await settled()).onSelect?.("personal");
    pane.render();
    pane.publicationView()!.onPublish?.();
    (await settled()).onConfirm?.();
    await settled();
    expect(request.mock.calls.filter(([method]) => method.startsWith("sessions.github."))).toEqual(
      ["options", "publish", "status", "confirm"].map((method) => [
        `sessions.github.${method}`,
        expect.objectContaining({ sessionKey: "global", agentId: "research" }),
      ]),
    );
  },
);

it("retires hidden publication feedback while retaining the admitted write and its result", async () => {
  const { request, responses, publications, settled, present } = createPublicationPane();
  const response = Promise.withResolvers<unknown>();
  responses.set("sessions.github.publish", response.promise);
  const ready = await settled();
  let retired = false;
  void ready.readiness.retired.then(() => {
    retired = true;
  });
  const completion = ready.onPublish?.();
  let completed = false;
  void Promise.resolve(completion).then(() => {
    completed = true;
  });
  expect(publications()).toHaveLength(1);

  present(false);
  // Hiding must retire the receipt before any render of the parked frame or RPC settlement.
  await Promise.resolve();
  expect(retired).toBe(true);
  expect(completed).toBe(false);

  const result = {
    requestId,
    publisher: shared,
    status: "published",
    url: "https://github.com/openclaw/openclaw/pull/111532",
    repository: "openclaw/openclaw",
    branch: "feature/publication",
    headCommit: "a".repeat(40),
  };
  response.resolve(result);
  await completion;
  present(true);
  expect((await settled()).result).toEqual(result);
  expect(publications()).toHaveLength(1);
  expect(
    request.mock.calls.filter(([method]) => method === "sessions.github.options"),
  ).toHaveLength(1);
});

it.each(["shared", "personal"] as const)(
  "retains an unknown %s publication across a retained-pane navigation",
  async (source) => {
    const { pane, state, request, options, settled, publications, present } =
      createPublicationPane();
    (await settled()).onSelect?.(source);
    pane.render();
    pane.publicationView()!.onPublish?.();
    let unknown = await settled();
    expect(unknown.locked).toBe(true);
    const first = publications()[0];
    expect(first?.[1]).toEqual({
      sessionKey: state.sessionKey,
      agentId: "main",
      idempotencyKey: expect.any(String),
      selection:
        source === "shared" ? { source, expected: shared } : { source, generation, account },
    });
    if (source === "shared") {
      options.shared = null;
      void unknown.onRefresh();
      unknown = await settled();
      expect(unknown.onPublish).toBeTypeOf("function");
    }

    present(false);
    pane.render();
    expect(pane.publicationView()).toBeUndefined();
    const hiddenRequests = request.mock.calls.length;
    void unknown.onPublish?.();
    void unknown.onRefresh();
    expect(request).toHaveBeenCalledTimes(hiddenRequests);
    present(true);
    const returned = await settled();

    expect([returned.locked, returned.selection]).toEqual([true, unknown.selection]);
    const knownRoster = state.sessionsResult!;
    state.sessionsResult = { ...knownRoster, count: 0, sessions: [] };
    const beforeMissingRow = request.mock.calls.length;
    void returned.onPublish?.();
    void returned.onRefresh();
    expect(request).toHaveBeenCalledTimes(beforeMissingRow);
    pane.render();
    expect(pane.publicationView()).toBeUndefined();
    state.sessionsResult = knownRoster;
    const restored = await settled();
    expect([restored.locked, restored.selection]).toEqual([true, unknown.selection]);
    void restored.onPublish?.();
    await settled();
    expect(publications()).toEqual([first, first]);
  },
);

it.each([
  "no read scope",
  "worktree",
  "repository",
  "no shared publisher",
  "viewer",
  "member",
  "unknown",
  "archived",
] as const)("derives publication controls from current access: %s", async (access) => {
  const { pane, state, context, request, options, settled, publications } = createPublicationPane(
    undefined,
    access === "no read scope" ? [] : ["operator.sessions.write"],
  );
  if (access === "no read scope") {
    pane.render();
    expect(pane.publicationView()).toBeUndefined();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.options")).toBe(false);
    return;
  }
  const row = state.sessionsResult!.sessions[0]!;
  row.sharingRole =
    access === "viewer" || access === "member"
      ? access
      : access === "unknown"
        ? undefined
        : "owner";
  row.archived = access === "archived";
  if (access === "repository") {
    delete row.worktree;
    row.repositoryWorkspaceId = "repository-publication";
    row.repository = {
      url: "https://github.com/synthetic/visitor-demo",
      branch: "feature/publication",
    };
  }
  if (access === "no shared publisher") {
    options.shared = null;
  }
  const guest = await settled();
  expect(guest).toMatchObject({ onSelect: undefined, onConfirm: undefined });
  if (access !== "worktree" && access !== "repository") {
    expect(guest.onPublish).toBeUndefined();
    expect(publications()).toHaveLength(0);
    return;
  }
  expect(guest.onPublish).toBeTypeOf("function");
  void guest.onPublish?.();
  await settled();
  expect(request).toHaveBeenLastCalledWith("sessions.github.publish", {
    sessionKey: state.sessionKey,
    agentId: "main",
    idempotencyKey: expect.any(String),
    selection: { source: "shared", expected: shared },
  });
  const previous = pane.publicationView()!;
  context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["sessions.github.publish", "sessions.github.options"],
    ["operator.sessions.read"],
  );
  void previous.onPublish?.();
  expect(publications()).toHaveLength(1);
  expect((await settled()).onPublish).toBeUndefined();
});

it.each(["incarnation", "sharing", "archive-projection"] as const)(
  "rejects a stale idle publication before render: %s",
  async (change) => {
    const { pane, state, context, publications, settled } = createPublicationPane();
    const idle = await settled();
    const current = state.sessionsResult!.sessions[0]!;
    const row = { ...current, updatedAt: 2 };
    if (change === "incarnation") {
      row.sessionId = "replacement";
    }
    if (change === "sharing") {
      row.visibility = "draft";
      row.sharingRole = "viewer";
    }
    if (change === "archive-projection") {
      state.selectedChatSessionArchived = true;
    }
    state.sessionsResult = { ...state.sessionsResult!, sessions: [row] };
    context.sessions.reconcile(row);
    // Invoke the captured action before rendering its replacement.
    void idle.onPublish?.();
    expect(publications()).toHaveLength(0);
    pane.render();
  },
);

it.each(["missing", "unknown"] as const)(
  "does not attach publication without a known required method: %s",
  (inventory) => {
    const { pane, context, request } = createPublicationPane();
    const hello = context.gateway.snapshot.hello!;
    hello.features = inventory === "missing" ? { methods: ["sessions.github.options"] } : undefined;
    pane.render();
    expect(pane.publicationView()).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method.startsWith("sessions.github."))).toEqual(
      [],
    );
  },
);
