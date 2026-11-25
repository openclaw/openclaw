import { ComponentType, InteractionType } from "discord-api-types/v10";
import { vi, type Mock } from "vitest";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { Client } from "./client.js";
import { Command, type CommandOptions, type DiscordCommand } from "./commands.js";
import type { RawInteraction } from "./interactions.js";
import type { RequestClient } from "./rest.js";

type RestMock = Partial<Record<"get" | "post" | "patch" | "put" | "delete", Mock>>;
type RawInteractionOverrides = Omit<Partial<RawInteraction>, "data" | "type"> &
  Pick<RawInteraction, "id" | "token"> & {
    data?: Record<string, unknown>;
  };

type FakeRestCall = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  data?: Parameters<RequestClient["post"]>[1];
  query?: Parameters<RequestClient["get"]>[1];
};

export function createTestCommand(
  name: string,
  options?: CommandOptions,
  config: Partial<Pick<Command, "description" | "run" | "defer" | "ephemeral">> = {},
) {
  return new (class extends Command {
    name = name;
    override description = config.description ?? `${name} command`;
    override options = options;
    override defer = config.defer ?? false;
    override ephemeral = config.ephemeral ?? false;
    run = config.run ?? (() => {});
  })();
}

export function createTestHashStore() {
  const rows = new Map<string, string>();
  const store = {
    lookup: vi.fn(async (key: string) => rows.get(key)),
    register: vi.fn(async (key: string, value: string) => {
      rows.set(key, value);
    }),
  } satisfies DiscordCommandDeployHashStore;
  return { rows, store };
}

export function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

export function createAbortableFetchMock() {
  let receivedSignal: AbortSignal | undefined;
  return {
    fetch: vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ),
    get receivedSignal() {
      return receivedSignal;
    },
  };
}

export function createInternalTestClient(
  commands: DiscordCommand[] = [],
  options?: Partial<ConstructorParameters<typeof Client>[0]>,
): Client {
  return new Client({ clientId: "app1", token: "token", ...options }, { commands });
}

export function attachRestMock(client: Client, rest: RestMock) {
  const mock = {
    options: client.rest.options,
    get: vi.fn(async () => undefined),
    post: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...rest,
  };
  client.rest = mock as RestMock & RequestClient;
  return mock;
}

export function createFakeRestClient(responses: unknown[] = []) {
  const calls: FakeRestCall[] = [];
  const queued = [...responses];
  const request = async (call: FakeRestCall) => {
    calls.push(call);
    return queued.shift();
  };
  return {
    calls,
    get: async (path, query) => await request({ method: "GET", path, data: undefined, query }),
    post: async (path, data, query) => await request({ method: "POST", path, data, query }),
    patch: async (path, data, query) => await request({ method: "PATCH", path, data, query }),
    put: async (path, data, query) => await request({ method: "PUT", path, data, query }),
    delete: async (path, data, query) => await request({ method: "DELETE", path, data, query }),
  } as RequestClient & { calls: FakeRestCall[] };
}

export function createInternalInteractionPayload(
  overrides: Partial<RawInteraction> & Pick<RawInteraction, "id" | "token">,
): RawInteraction {
  return {
    application_id: "app1",
    type: InteractionType.ApplicationCommand,
    version: 1,
    data: { id: "command1", name: "test", type: 1 },
    ...overrides,
  } as unknown as RawInteraction;
}

export const createInternalComponentInteractionPayload = interactivePayload(
  InteractionType.MessageComponent,
);

export const createInternalModalInteractionPayload = interactivePayload(
  InteractionType.ModalSubmit,
);

function interactivePayload(type: InteractionType.MessageComponent | InteractionType.ModalSubmit) {
  return ({ data, ...rest }: RawInteractionOverrides): RawInteraction =>
    ({
      application_id: "app1",
      version: 1,
      data: {
        ...(type === InteractionType.MessageComponent
          ? { component_type: ComponentType.Button, custom_id: "component1" }
          : { custom_id: "modal1", components: [] }),
        ...data,
      },
      ...rest,
      type,
    }) as unknown as RawInteraction;
}
