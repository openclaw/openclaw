import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackMonitorEventScope } from "./event-scope.js";

const identity = { kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" } as const;
const client = new WebClient("listener-token");
const context = { isEnterpriseInstall: true, enterpriseId: "E123", teamId: "T111" };
type ScopeParams = Parameters<typeof resolveSlackMonitorEventScope>[0];
function resolveScope(overrides: Partial<ScopeParams> = {}) {
  return resolveSlackMonitorEventScope({
    ctx: { installationIdentity: identity, app: {} },
    body: { api_app_id: "A123" },
    context,
    client,
    ...overrides,
  });
}

describe("resolveSlackMonitorEventScope", () => {
  it.each(["T111", "workspace/Mixed Case"])(
    "preserves authorized workspace %s in the same org",
    (teamId) => {
      const listenerClient = new WebClient(`listener-token-${teamId.toLowerCase()}`);
      const result = resolveScope({
        context: { ...context, teamId },
        client: listenerClient,
      });
      expect(result).toMatchObject({ teamId, client: listenerClient });
      expect(result?.client).toBe(listenerClient);
      expect(result?.writeClient).toBeInstanceOf(WebClient);
      expect(result?.writeClient).not.toBe(listenerClient);
    },
  );

  it("accepts a Bolt-authenticated payload that does not carry api_app_id", () => {
    expect(resolveScope({ body: {} })).toMatchObject({ teamId: "T111", client });
  });

  it("relies on WebClient team scoping instead of adding team_id to method payloads", async () => {
    let encodedRequestBody = "";
    const teamScopedClient = new WebClient("xoxb-test", {
      teamId: "T111",
      retryConfig: { retries: 0 },
      fetch: (_input, init) => {
        encodedRequestBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(Response.json({ ok: true, ts: "123.456", channel: "C123" }));
      },
    });
    const methodPayload = { channel: "C123", text: "hello" };
    const postChatMessage = teamScopedClient.chat.postMessage.bind(teamScopedClient.chat);

    await postChatMessage(methodPayload);

    expect(methodPayload).not.toHaveProperty("team_id");
    expect(new URLSearchParams(encodedRequestBody).get("team_id")).toBe("T111");
  });

  it.each([
    ["wrong app", { body: { api_app_id: "A999" } }, "wrong_app"],
    ["wrong org", { context: { enterpriseId: "E999" } }, "wrong_enterprise"],
    ["missing team", { context: { teamId: undefined } }, "missing_team_id"],
    ["missing client", { client: undefined }, "missing_listener_client"],
  ] as const)("rejects %s", (_label, override, reason) => {
    const onDrop = vi.fn();
    expect(
      resolveScope({
        ...override,
        onDrop,
        context: { ...context, ...("context" in override ? override.context : {}) },
      }),
    ).toBeNull();
    expect(onDrop).toHaveBeenLastCalledWith(reason);
  });

  it("rejects enterprise events for workspace and degraded accounts", () => {
    for (const workspaceIdentity of [
      { kind: "workspace", apiAppId: "A123", teamId: "T111" } as const,
      { kind: "degraded", reason: "auth_test_failed" } as const,
    ]) {
      const onDrop = vi.fn();
      expect(
        resolveScope({
          ctx: { installationIdentity: workspaceIdentity, app: {} },
          onDrop,
        }),
      ).toBeNull();
      expect(onDrop).toHaveBeenLastCalledWith("enterprise_event_for_workspace_account");
    }
  });
});
