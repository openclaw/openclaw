import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { factoryGitHubRequestDigest } from "../../gateway/factory-github-proof.js";
import { factoryGitHubProofHandlers } from "../../gateway/server-methods/factory-github-proof.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as command from "../../process/exec.js";

type Binding = {
  actorId: number;
  profileId: string;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  repositoryUrl: string;
  context: GatewayRequestContext;
};

export const factoryRestartChanges = [
  "current grant",
  "missing factory actor",
  "forged only",
  "actor mismatch",
  "host mismatch",
  "alias moved",
  "device removed",
  "grant ended",
  "grant unavailable",
  "role revoked",
  "wrong repository",
  "late repository replaced",
  "broker lease missing",
  "broker actor changed",
  "late role revoke",
  "manual pause",
  "cancel",
  "complete",
  "unknown effect",
] as const;

/** External gh/broker/GitHub stand-ins; native issuance, redemption and repository admission remain real. */
export function installFactoryRestartRepositoryFixture(params: {
  binding: () => Binding;
  afterLookup: () => Promise<void>;
  broker: () => "current" | "missing lease" | "different actor";
  repositorySnapshot?: () => { commit: string; tree: string } | undefined;
  allowPublicationPreflight?: true;
  allowSessionCreate?: true;
}) {
  const proofs = new Set<string>();
  const result = (token = "", code = 0) => ({
    stdout: Buffer.from(token),
    stderr: Buffer.alloc(0),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  });
  const runCommandBuffered = command.runCommandBuffered;
  const native = vi
    .spyOn(command, "runCommandBuffered")
    .mockImplementation(async (argv, options) => {
      if (argv[0] === "git") {
        return await runCommandBuffered(argv, options);
      }
      expect(argv.slice(1)).toEqual(["auth", "token", "--hostname", "microsoft.ghe.com"]);
      const proof = expectDefined(
        options?.env?.OPENCLAW_FACTORY_GITHUB_PROOF,
        "new original-issuer proof",
      );
      expect(proofs.has(proof)).toBe(false);
      proofs.add(proof);
      const binding = params.binding();
      const respond = vi.fn();
      const request: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "restored-lookup", method: "factory.githubPublication.redeem" },
        params: { proof },
        respond,
        isWebchatConnect: () => false,
        client: {
          ...createOperatorClient({ profileId: binding.profileId, scopes: ["operator.admin"] }),
          internal: {
            isLocalClient: true,
            authenticatedOperator: true,
            operatorRoleActor: { kind: "system" },
          },
        },
        context: { ...binding.context, isConnectionActive: () => true },
        hasCurrentClientAuthority: () => true,
      };
      const redeem = expectDefined(
        factoryGitHubProofHandlers[request.req.method],
        "registered private proof handler",
      );
      await redeem(request);
      const verdict: unknown = respond.mock.calls[0]?.[1];
      if (
        params.allowPublicationPreflight &&
        isRecord(verdict) &&
        verdict.purpose === "publication-preflight"
      ) {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            actorId: binding.actorId,
            profileId: binding.profileId,
            purpose: "publication-preflight",
            binding: expect.objectContaining({
              kind: "session",
              agentId: binding.agentId,
              sessionKey: binding.sessionKey,
              sessionId: expectDefined(binding.sessionId, "exact publication session"),
            }),
          }),
        );
      } else if (
        params.allowSessionCreate &&
        isRecord(verdict) &&
        verdict.purpose === "session-create-project"
      ) {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            actorId: binding.actorId,
            profileId: binding.profileId,
            purpose: "session-create-project",
            binding: {
              kind: "session-create",
              agentId: binding.agentId,
              sessionKey: binding.sessionKey,
              ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
              requestDigest: factoryGitHubRequestDigest(binding.repositoryUrl),
            },
          }),
        );
      } else {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            actorId: binding.actorId,
            profileId: binding.profileId,
            purpose: "session-dispatch-project",
            binding: {
              kind: "session-dispatch",
              agentId: binding.agentId,
              sessionKey: binding.sessionKey,
              sessionId: expectDefined(binding.sessionId, "exact dispatch session"),
              requestDigest: factoryGitHubRequestDigest(binding.repositoryUrl),
            },
          }),
        );
      }
      const replay = vi.fn();
      await redeem({ ...request, respond: replay });
      expect(replay).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      await params.afterLookup();
      return params.broker() === "current"
        ? result("synthetic-restored-factory-token")
        : result("", 1);
    });
  const fetchFixture = vi.fn<typeof fetch>(async (input, init) => {
    const binding = params.binding();
    expect(new Headers(init?.headers).get("authorization")).toContain(
      "synthetic-restored-factory-token",
    );
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe("https://api.microsoft.ghe.com");
    const repositoryPath = `/repos${new URL(binding.repositoryUrl).pathname.replace(/\.git$/u, "")}`;
    const snapshot = params.repositorySnapshot?.();
    const commit = snapshot?.commit ?? "a".repeat(40);
    const tree = snapshot?.tree ?? "b".repeat(40);
    const repository = {
      node_id: "R_restored_factory",
      clone_url: binding.repositoryUrl,
      private: true,
      default_branch: "main",
    };
    let body: unknown;
    if (url.pathname === "/user") {
      body = { id: binding.actorId, login: "fixture-original-issuer", type: "User" };
    } else if (url.pathname === "/graphql") {
      const request: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      expect(request).toMatchObject({ variables: { repositoryId: repository.node_id, commit } });
      body = {
        data: {
          node: {
            ...repository,
            __typename: "Repository",
            object: { __typename: "Commit", sha: commit, tree: { sha: tree } },
          },
        },
      };
    } else if (url.pathname === repositoryPath) {
      body = repository;
    } else if (url.pathname === `${repositoryPath}/git/commits/${commit}`) {
      body = { sha: commit, tree: { sha: tree } };
    } else if (
      url.pathname === `${repositoryPath}/commits/main` ||
      decodeURIComponent(url.pathname) === `${repositoryPath}/commits/heads/main`
    ) {
      body = { sha: commit, commit: { tree: { sha: tree } } };
    } else if (url.pathname === `${repositoryPath}/git/trees/${tree}`) {
      body = { sha: tree, truncated: false, tree: [] };
    } else {
      throw new Error("Repository read left the exact accepted target");
    }
    return Response.json(body);
  });
  vi.stubGlobal("fetch", fetchFixture);
  return { proofs, native, fetchFixture };
}
