import { afterEach, describe, expect, it, vi } from "vitest";
import * as replyAuthority from "../../auto-reply/reply/reply-tool-authority.js";
import type { ReplyToolAuthorityInput } from "../../auto-reply/reply/reply-tool-authority.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureReplyExecutionSelection,
  isSameReplyExecutionSelection,
} from "../../sessions/session-controller.execution-selection.js";
import * as joinObservation from "../../sessions/session-controller.message-join-observation.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import { resolveAgentDir } from "../agent-scope.js";
import { captureCliRunToolAuthority } from "./tool-authority.js";
import type { RunCliAgentParams } from "./types.js";

afterEach(() => vi.restoreAllMocks());

type AuthorityRead = { key: PropertyKey; present: boolean; value: unknown };
function observeReads<T extends object>(target: T, reads: AuthorityRead[]): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      reads.push({ key, present: Object.hasOwn(object, key), value });
      return value;
    },
  });
}

describe("CLI question creator binding", () => {
  it("projects the same policy and execution facts without reading the prompt", () => {
    const optionalFacts = [
      "sessionKey",
      "runtimePolicySessionKey",
      "config",
      "agentDir",
      "agentAccountId",
      "operatorProfileId",
      "messageProvider",
      "requesterOrigin",
      "conversationId",
      "conversationToolPolicy",
      "senderIsOwner",
      "gitContributorProfileId",
      "inputProvenance",
      "trustedInternalHandoff",
      "scheduledToolPolicy",
      "execOverrides",
      "bashElevated",
      "approvalReviewerDeviceId",
      "authProfileId",
      "clientCaps",
      "gatewayUiCommandTarget",
    ] as const satisfies readonly (keyof RunCliAgentParams)[];
    let promptReads = 0;
    const params: RunCliAgentParams = {
      ...Object.fromEntries(optionalFacts.map((key) => [key, undefined])),
      sessionId: "cli-policy-projection",
      sessionFile: "/workspace/session.jsonl",
      workspaceDir: "/caller-workspace",
      cwd: "/caller-cwd",
      provider: "cli",
      modelProvider: "fixture",
      model: "fixture-model",
      timeoutMs: 1_000,
      runId: "cli-policy-projection",
      get prompt() {
        promptReads++;
        return "private turn body";
      },
      messageProvider: "telegram",
      senderId: null,
      senderName: "Sender",
      sessionEntry: {
        sessionId: "cli-policy-projection",
        updatedAt: 1,
        chatType: "group",
        permissionMode: "full",
        toolOverrides: { webSearch: false },
      },
      authProfileId: "selected-profile",
    };
    const workspace = { agentId: "main", workspaceDir: "/workspace", cwd: "/workspace/subdir" };
    // These are the only reply-owner reads absent from RunCliAgentParams.
    const absentKeys = [
      "authProfileIdSource",
      "elevatedLevel",
      "memberRoleIds",
      "messageThreadId",
      "runtimePluginToolGrant",
      "toolBindings",
      "traceAuthorized",
    ] as const satisfies readonly Exclude<
      keyof ReplyToolAuthorityInput["run"],
      keyof RunCliAgentParams
    >[];
    const prepare = replyAuthority.prepareReplyToolAuthority;
    const capture = joinObservation.captureReplyMessageJoinObservation;
    const observationSpy = vi
      .spyOn(joinObservation, "captureReplyMessageJoinObservation")
      .mockImplementationOnce((input) => {
        const legacyReads: AuthorityRead[] = [];
        const projectedReads: AuthorityRead[] = [];
        const legacy = capture({
          ...input,
          // The caller's cwd and agentDir, as an incoming reply records them.
          run: observeReads(
            {
              ...params,
              ...workspace,
              cwd: params.cwd,
              agentDir: params.agentDir,
            },
            legacyReads,
          ),
        });
        const projected = capture({ ...input, run: observeReads(input.run, projectedReads) });
        expect(projectedReads).toEqual(legacyReads);
        expect([
          ...new Set(projectedReads.filter((read) => !read.present).map((read) => read.key)),
        ]).toEqual(["authProfileIdSource"]);
        expect(projected).toEqual(legacy);
        return projected;
      });
    const authoritySpy = vi
      .spyOn(replyAuthority, "prepareReplyToolAuthority")
      .mockImplementationOnce((input, ...rest) => {
        const legacyReads: AuthorityRead[] = [];
        const projectedReads: AuthorityRead[] = [];
        const legacyRun = {
          ...params,
          agentId: workspace.agentId,
          chatType: params.chatType ?? params.sessionEntry?.chatType,
          provider: params.modelProvider ?? params.provider,
          model: params.model ?? "default",
          workspaceDir: workspace.workspaceDir,
          cwd: workspace.cwd,
          permissionMode: params.sessionEntry?.permissionMode,
          toolOverrides: params.toolOverrides ?? params.sessionEntry?.toolOverrides,
          senderId: params.senderId ?? undefined,
          senderName: params.senderName ?? undefined,
          senderUsername: params.senderUsername ?? undefined,
          senderE164: params.senderE164 ?? undefined,
          groupId: params.groupId ?? undefined,
          groupChannel: params.groupChannel ?? undefined,
          groupSpace: params.groupSpace ?? undefined,
          spawnedBy: params.spawnedBy ?? undefined,
        };
        const legacy = prepare({ ...input, run: observeReads(legacyRun, legacyReads) }, ...rest);
        const projected = prepare(
          { ...input, run: observeReads(input.run, projectedReads) },
          ...rest,
        );
        try {
          expect(projectedReads).toEqual(legacyReads);
          expect(
            new Set(
              projectedReads
                .filter((read) => typeof read.key === "string" && !read.present)
                .map((read) => read.key),
            ),
          ).toEqual(new Set(absentKeys));
          expect(projected.personalToolOwner).toEqual(legacy.personalToolOwner);
          expect(projected.requesterPrincipalKey).toBe(legacy.requesterPrincipalKey);
          expect(projected.requestedRoute).toEqual(legacy.requestedRoute);
        } finally {
          legacy.close();
        }
        return projected;
      });
    using authority = captureCliRunToolAuthority(params, workspace);
    expect(observationSpy).toHaveBeenCalledOnce();
    expect(authoritySpy).toHaveBeenCalledOnce();
    // The two legacy reconstructions above read the getter once apiece; production must not.
    expect(promptReads).toBe(2);
    expect(authority.finalizeSessionEventSourcePolicy(params).settings?.toolOverrides).toEqual({
      webSearch: false,
    });
  });

  it("carries the host-issued profile into question authority", async () => {
    const source = createTestOperatorAuthority({
      profileId: "creator-profile",
      scopes: ["operator.write"],
    });
    using authority = captureCliRunToolAuthority(
      {
        sessionId: "agent:main:question",
        sessionFile: "/workspace/session.jsonl",
        workspaceDir: "/workspace",
        provider: "fixture",
        prompt: "question",
        timeoutMs: 1_000,
        runId: "question-creator",
      },
      { agentId: "main", workspaceDir: "/workspace", cwd: "/workspace" },
    );
    const bound = await authority.bindQuestions(
      { provider: "fixture", model: "fixture" },
      () => source,
    );
    const question = bound.bindQuestionAnswerAuthority(() => {});
    expect(question.requesterProfileId).toBe("creator-profile");
    expect(() => question.assertActive()).not.toThrow();
  });
});

describe("CLI steering join observation", () => {
  it("records the caller's execution selection, as an incoming reply does", () => {
    const config: OpenClawConfig = {};
    const sessionEntry: SessionEntry = { sessionId: "agent:main:main", updatedAt: 1 };
    const observe = vi.spyOn(joinObservation, "captureReplyMessageJoinObservation");
    // Agent-command dispatch (e.g. a helper-result turn) passes its agent dir but no cwd;
    // the runner derives its cwd after this capture.
    using authority = captureCliRunToolAuthority(
      {
        sessionId: "agent:main:main",
        sessionFile: "/workspace/session.jsonl",
        workspaceDir: "/workspace",
        agentDir: resolveAgentDir(config, "main"),
        config,
        sessionEntry,
        provider: "fixture",
        prompt: "helper result",
        timeoutMs: 1_000,
        runId: "helper-result",
      },
      { agentId: "main", workspaceDir: "/workspace", cwd: "/workspace" },
    );
    expect(authority.hasReplyOperation).toBe(false);
    const active = observe.mock.results[0]?.value.executionSelection;
    // An incoming reply records its run as admitted: agentDir resolved, cwd left to the runner.
    const incoming = (run: { agentDir?: string; cwd?: string }) =>
      captureReplyExecutionSelection({
        run: {
          config,
          agentId: "main",
          agentDir: resolveAgentDir(config, "main"),
          sessionFile: "/workspace/session.jsonl",
          workspaceDir: "/workspace",
          ...run,
        },
        sessionEntry,
      });
    expect(isSameReplyExecutionSelection(active, incoming({}))).toBe(true);
    expect(isSameReplyExecutionSelection(active, incoming({ cwd: "/elsewhere" }))).toBe(false);
    expect(isSameReplyExecutionSelection(active, incoming({ agentDir: "/other-agent" }))).toBe(
      false,
    );
  });
});
