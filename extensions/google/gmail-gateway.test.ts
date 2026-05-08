import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildGmailAuthUrl: vi.fn(),
  exchangeGmailCodeForTokens: vi.fn(),
  resolveGooglePersonalOAuthIdentity: vi.fn(),
  listGmailStoredProfiles: vi.fn(),
  resolveStoredGmailCredential: vi.fn(),
  storeGmailOAuthCredentials: vi.fn(),
  persistGmailRefresh: vi.fn(),
  createGmailClient: vi.fn(),
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

vi.mock("openclaw/plugin-sdk/error-runtime", () => ({
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("./gmail-auth-store.js", () => ({
  GMAIL_PROVIDER_ID: "google-gmail",
  listGmailStoredProfiles: mocks.listGmailStoredProfiles,
  resolveStoredGmailCredential: mocks.resolveStoredGmailCredential,
  storeGmailOAuthCredentials: mocks.storeGmailOAuthCredentials,
  persistGmailRefresh: mocks.persistGmailRefresh,
}));

vi.mock("./gmail-oauth.js", () => ({
  buildGmailAuthUrl: mocks.buildGmailAuthUrl,
  exchangeGmailCodeForTokens: mocks.exchangeGmailCodeForTokens,
}));

vi.mock("./oauth.project.js", () => ({
  resolveGooglePersonalOAuthIdentity: mocks.resolveGooglePersonalOAuthIdentity,
}));

vi.mock("./gmail-client.js", () => ({
  createGmailClient: mocks.createGmailClient,
}));

import { registerGmailGatewayMethods } from "./gmail-gateway.js";

type RegisteredMethod = {
  handler: (ctx: {
    params: Record<string, unknown>;
    respond: (ok: boolean, result?: unknown, error?: unknown) => void;
  }) => Promise<void>;
};

function buildApi() {
  const methods = new Map<string, RegisteredMethod>();
  return {
    api: {
      config: {},
      registerGatewayMethod: vi.fn((name: string, handler: RegisteredMethod["handler"]) => {
        methods.set(name, { handler });
      }),
    },
    methods,
  };
}

async function invoke(
  methods: Map<string, RegisteredMethod>,
  name: string,
  params: Record<string, unknown> = {},
) {
  const method = methods.get(name);
  if (!method) {
    throw new Error(`Missing method ${name}`);
  }
  return await new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) => {
    void method.handler({ params, respond: (ok, result, error) => resolve({ ok, result, error }) });
  });
}

describe("registerGmailGatewayMethods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Gmail auth URL", async () => {
    mocks.buildGmailAuthUrl.mockReturnValue("https://accounts.google.test/oauth");
    const { api, methods } = buildApi();

    registerGmailGatewayMethods(api as never);
    const response = await invoke(methods, "gmail.auth.url", {
      challenge: "challenge-1",
      state: "state-1",
      redirectUri: "http://localhost:3000/overview",
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      providerId: "google-gmail",
      url: "https://accounts.google.test/oauth",
    });
    expect(mocks.buildGmailAuthUrl).toHaveBeenCalledWith({
      challenge: "challenge-1",
      state: "state-1",
      redirectUri: "http://localhost:3000/overview",
    });
  });

  it("exchanges OAuth code and stores Gmail credentials", async () => {
    mocks.exchangeGmailCodeForTokens.mockResolvedValue({
      access: "access-1",
      refresh: "refresh-1",
      expires: 123456789,
    });
    mocks.resolveGooglePersonalOAuthIdentity.mockResolvedValue({ email: "david@example.com" });
    mocks.storeGmailOAuthCredentials.mockResolvedValue("google-gmail:david@example.com");
    const { api, methods } = buildApi();

    registerGmailGatewayMethods(api as never);
    const response = await invoke(methods, "gmail.auth.exchange", {
      code: "code-1",
      verifier: "verifier-1",
      redirectUri: "http://localhost:3000/overview",
    });

    expect(response.ok).toBe(true);
    expect(mocks.exchangeGmailCodeForTokens).toHaveBeenCalledWith({
      code: "code-1",
      verifier: "verifier-1",
      redirectUri: "http://localhost:3000/overview",
    });
    expect(mocks.storeGmailOAuthCredentials).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      access: "access-1",
      refresh: "refresh-1",
      expires: 123456789,
      email: "david@example.com",
    });
    expect(response.result).toEqual({
      providerId: "google-gmail",
      profileId: "google-gmail:david@example.com",
      email: "david@example.com",
      expires: 123456789,
    });
  });

  it("sends a message through the resolved Gmail profile", async () => {
    mocks.resolveStoredGmailCredential.mockReturnValue({
      profileId: "google-gmail:david@example.com",
      credential: {
        type: "oauth",
        provider: "google-gmail",
        access: "access-1",
        refresh: "refresh-1",
        expires: Date.now() + 60_000,
      },
    });
    const sendMessage = vi.fn().mockResolvedValue({ id: "sent-1", threadId: "thread-1" });
    mocks.createGmailClient.mockReturnValue({ sendMessage });
    const { api, methods } = buildApi();

    registerGmailGatewayMethods(api as never);
    const response = await invoke(methods, "gmail.messages.send", {
      to: "alex@example.com",
      subject: "Hello",
      textBody: "Sent body",
      threadId: "thread-1",
    });

    expect(response.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({
      to: "alex@example.com",
      subject: "Hello",
      textBody: "Sent body",
      threadId: "thread-1",
    });
    expect(response.result).toEqual({
      profileId: "google-gmail:david@example.com",
      message: { id: "sent-1", threadId: "thread-1" },
    });
  });

  it("lists messages through the resolved Gmail profile", async () => {
    mocks.resolveStoredGmailCredential.mockReturnValue({
      profileId: "google-gmail:david@example.com",
      credential: {
        type: "oauth",
        provider: "google-gmail",
        access: "access-1",
        refresh: "refresh-1",
        expires: Date.now() + 60_000,
      },
    });
    const listMessages = vi.fn().mockResolvedValue({ messages: [{ id: "m1", threadId: "t1" }] });
    mocks.createGmailClient.mockReturnValue({ listMessages });
    const { api, methods } = buildApi();

    registerGmailGatewayMethods(api as never);
    const response = await invoke(methods, "gmail.messages.list", { maxResults: 5 });

    expect(response.ok).toBe(true);
    expect(listMessages).toHaveBeenCalledWith({
      maxResults: 5,
      pageToken: undefined,
      query: undefined,
      labelIds: undefined,
      includeSpamTrash: undefined,
    });
    expect(response.result).toEqual({
      profileId: "google-gmail:david@example.com",
      messages: [{ id: "m1", threadId: "t1" }],
    });
  });
});
