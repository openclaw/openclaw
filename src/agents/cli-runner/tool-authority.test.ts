import { afterEach, describe, expect, it, vi } from "vitest";
import * as replyAuthority from "../../auto-reply/reply/reply-tool-authority.js";
import type { ReplyToolAuthorityInput } from "../../auto-reply/reply/reply-tool-authority.types.js";
import * as joinObservation from "../../sessions/session-controller.message-join-observation.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
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
          run: observeReads({ ...params, ...workspace }, legacyReads),
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

  it("carries the host-issued profile and refuses it after its source is revoked", async () => {
    let active = true;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "creator-profile",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!active) {
          throw new Error("source revoked");
        }
      },
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
    active = false;
    expect(() => question.assertActive()).toThrow("source revoked");
  });
});
