export type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

type ClientOptions = {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
};

type MockClient = {
  apiKey: string;
  baseURL: string;
  responses: {
    create: (
      request: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => { withResponse: () => Promise<SdkResponse | undefined> };
  };
  withOptions: (options: { apiKey?: string }) => MockClient;
};
type MockClientConstructor = new (options?: ClientOptions) => MockClient;

export function createResponsesSdkMock(
  state: { outcomes: Array<Error | SdkResponse>; requests?: Array<Record<string, unknown>> },
  hooks: {
    onConstruct?: (options: ClientOptions) => void;
    onCreate?: (provider: "openai" | "azure", signal?: AbortSignal) => void;
    // Preserve suites that consume the queue only when withResponse is awaited.
    dequeueOnResponse?: boolean;
    unexpectedRequest?: string;
  } = {},
): { default: MockClientConstructor; AzureOpenAI: MockClientConstructor } {
  const takeOutcome = () =>
    state.outcomes.shift() ?? new Error(hooks.unexpectedRequest ?? "Unexpected SSE request");
  const createClient = (provider: "openai" | "azure") =>
    class MockOpenAI {
      apiKey: string;
      baseURL: string;
      responses = {
        create: (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          hooks.onCreate?.(provider, options?.signal);
          state.requests?.push(request);
          const outcome = hooks.dequeueOnResponse ? undefined : takeOutcome();
          return {
            withResponse: async () => {
              const response = hooks.dequeueOnResponse ? takeOutcome() : outcome;
              if (response instanceof Error) {
                throw response;
              }
              return response;
            },
          };
        },
      };

      constructor(options: ClientOptions = {}) {
        this.apiKey = options.apiKey ?? "";
        this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
        hooks.onConstruct?.(options);
      }

      withOptions(options: { apiKey?: string }) {
        return new MockOpenAI({ apiKey: options.apiKey ?? this.apiKey, baseURL: this.baseURL });
      }
    };
  return { default: createClient("openai"), AzureOpenAI: createClient("azure") };
}
