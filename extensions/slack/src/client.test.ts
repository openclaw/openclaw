import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

let createSlackWebClient: typeof import("./client.js").createSlackWebClient;
let createSlackWriteClient: typeof import("./client.js").createSlackWriteClient;
let resolveSlackWebClientOptions: typeof import("./client.js").resolveSlackWebClientOptions;
let resolveSlackWriteClientOptions: typeof import("./client.js").resolveSlackWriteClientOptions;
let SLACK_DEFAULT_RETRY_OPTIONS: typeof import("./client.js").SLACK_DEFAULT_RETRY_OPTIONS;
let SLACK_WRITE_RETRY_OPTIONS: typeof import("./client.js").SLACK_WRITE_RETRY_OPTIONS;
let WebClient: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const slackWebApi = await import("@slack/web-api");
  ({
    createSlackWebClient,
    createSlackWriteClient,
    resolveSlackWebClientOptions,
    resolveSlackWriteClientOptions,
    SLACK_DEFAULT_RETRY_OPTIONS,
    SLACK_WRITE_RETRY_OPTIONS,
  } = await import("./client.js"));
  WebClient = slackWebApi.WebClient as unknown as ReturnType<typeof vi.fn>;
});

beforeEach(() => {
  WebClient.mockClear();
});

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

  it("applies the write retry config when none is provided", () => {
    const options = resolveSlackWriteClientOptions();

    expect(options.retryConfig).toEqual(SLACK_WRITE_RETRY_OPTIONS);
  });

  it("passes no-retry config into the write client by default", () => {
    createSlackWriteClient("xoxb-test", { timeout: 4321 });

    expect(WebClient).toHaveBeenCalledWith(
      "xoxb-test",
      expect.objectContaining({
        timeout: 4321,
        retryConfig: SLACK_WRITE_RETRY_OPTIONS,
      }),
    );
  });
});
