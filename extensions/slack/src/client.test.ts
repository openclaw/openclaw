import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@slack/web-api", () => {
  const WebClient = vi.fn(function WebClientMock(
    this: Record<string, unknown>,
    token: string,
    options?: Record<string, unknown>,
  ) {
    this.token = token;
    this.options = options;
  });
  return { WebClient };
});

const resolveEnvHttpProxyUrlMock = vi.hoisted(() => vi.fn());
const HttpsProxyAgentMock = vi.hoisted(() =>
  vi.fn().mockImplementation(function MockHttpsProxyAgent(
    this: Record<string, unknown>,
    proxyUrl: string,
  ) {
    this.proxyUrl = proxyUrl;
  }),
);

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  resolveEnvHttpProxyUrl: (...args: unknown[]) =>
    resolveEnvHttpProxyUrlMock(...(args as [protocol: "http" | "https", env?: NodeJS.ProcessEnv])),
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: HttpsProxyAgentMock,
}));

const slackWebApi = await import("@slack/web-api");
const { createSlackWebClient, resolveSlackWebClientOptions, SLACK_DEFAULT_RETRY_OPTIONS } =
  await import("./client.js");

const WebClient = slackWebApi.WebClient as unknown as ReturnType<typeof vi.fn>;

describe("slack web client config", () => {
  beforeEach(() => {
    resolveEnvHttpProxyUrlMock.mockReset();
    HttpsProxyAgentMock.mockClear();
    WebClient.mockClear();
  });

  it("uses env proxy agent when no explicit agent is provided", () => {
    resolveEnvHttpProxyUrlMock.mockReturnValue("http://proxy.test:8080");

    const options = resolveSlackWebClientOptions({ timeout: 1234 });

    expect(resolveEnvHttpProxyUrlMock).toHaveBeenCalledWith("https", process.env);
    expect(HttpsProxyAgentMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(options).toEqual(
      expect.objectContaining({
        timeout: 1234,
        agent: expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }),
        retryConfig: SLACK_DEFAULT_RETRY_OPTIONS,
      }),
    );
  });

  it("does not override explicit agent with env proxy", () => {
    resolveEnvHttpProxyUrlMock.mockReturnValue("http://proxy.test:8080");
    const explicitAgent = { kind: "explicit-agent" } as unknown as
      | import("@slack/web-api").WebClientOptions["agent"]
      | undefined;

    const options = resolveSlackWebClientOptions({ agent: explicitAgent });

    expect(resolveEnvHttpProxyUrlMock).not.toHaveBeenCalled();
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
    expect(options.agent).toBe(explicitAgent);
  });

  it("does not set agent when proxy env is absent", () => {
    resolveEnvHttpProxyUrlMock.mockReturnValue(undefined);

    const options = resolveSlackWebClientOptions({ timeout: 1234 });

    expect(resolveEnvHttpProxyUrlMock).toHaveBeenCalledWith("https", process.env);
    expect(HttpsProxyAgentMock).not.toHaveBeenCalled();
    expect(options.agent).toBeUndefined();
  });

  it("applies the default retry config when none is provided", () => {
    const options = resolveSlackWebClientOptions();

    expect(options.retryConfig).toEqual(SLACK_DEFAULT_RETRY_OPTIONS);
  });

  it("respects explicit retry config overrides", () => {
    const customRetry = { retries: 0 };
    const options = resolveSlackWebClientOptions({ retryConfig: customRetry });

    expect(options.retryConfig).toBe(customRetry);
  });

  it("passes merged options into WebClient", () => {
    createSlackWebClient("xoxb-test", { timeout: 1234 });

    expect(WebClient).toHaveBeenCalledWith(
      "xoxb-test",
      expect.objectContaining({
        timeout: 1234,
        retryConfig: SLACK_DEFAULT_RETRY_OPTIONS,
      }),
    );
  });
});
