import { HttpsProxyAgent } from "https-proxy-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const slackWebApi = await import("@slack/web-api");
const {
  createSlackWebClient,
  resolveSlackWebClientOptions,
  setSlackClientRuntimeForTest,
  SLACK_DEFAULT_RETRY_OPTIONS,
} = await import("./client.js");

const WebClient = slackWebApi.WebClient as unknown as ReturnType<typeof vi.fn>;

describe("slack web client config", () => {
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

describe("slack proxy agent", () => {
  afterEach(() => {
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    setSlackClientRuntimeForTest();
  });

  it("includes an HttpsProxyAgent when HTTPS_PROXY is set", () => {
    process.env.HTTPS_PROXY = "http://proxy.test:8080";
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeInstanceOf(HttpsProxyAgent);
  });

  it("does not include agent when no proxy env is set", () => {
    const options = resolveSlackWebClientOptions();

    expect(options.agent).toBeUndefined();
  });

  it("does not override an explicit agent option", () => {
    process.env.HTTPS_PROXY = "http://proxy.test:8080";
    const customAgent = new HttpsProxyAgent("http://custom.test:9090");
    const options = resolveSlackWebClientOptions({ agent: customAgent });

    expect(options.agent).toBe(customAgent);
  });

  it("silently falls back when proxy agent constructor throws", () => {
    process.env.HTTPS_PROXY = "http://proxy.test:8080";
    const ThrowingCtor = function () {
      throw new Error("boom");
    } as unknown as typeof HttpsProxyAgent;
    setSlackClientRuntimeForTest({ HttpsProxyAgent: ThrowingCtor });

    const options = resolveSlackWebClientOptions();
    expect(options.agent).toBeUndefined();
  });
});
