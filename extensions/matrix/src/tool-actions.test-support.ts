import { vi } from "vitest";
import type { ChannelMessageActionContext } from "../runtime-api.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => {
  const respond = (value: unknown) =>
    vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve(value));
  const matrixClient = { id: "matrix-client" };
  return {
    voteMatrixPoll: respond({
      eventId: "evt-poll-vote",
      roomId: "!room:example",
      pollId: "$poll",
      answerIds: ["a1", "a2"],
      labels: ["Pizza", "Sushi"],
      maxSelections: 2,
    }),
    reactMatrixMessage: vi.fn(),
    editMatrixMessage: vi.fn(),
    deleteMatrixMessage: vi.fn(),
    readMatrixMessage: vi.fn(),
    readMatrixMessages: vi.fn(),
    listMatrixEmojis: respond([
      { name: "party", identifier: "party", url: "mxc://example.org/party" },
    ]),
    listMatrixReactions: respond([{ key: "👍", count: 1, users: ["@u:example"] }]),
    removeMatrixReactions: respond({ removed: 1 }),
    sendMatrixMessage: vi.fn(),
    pinMatrixMessage: respond({ pinned: ["$existing", "$pin"] }),
    unpinMatrixMessage: respond({ pinned: ["$existing"] }),
    listMatrixPins: vi.fn(),
    getMatrixMemberInfo: vi.fn(),
    getMatrixRoomInfo: vi.fn(),
    applyMatrixProfileUpdate: respond({
      accountId: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/avatar",
      profile: {
        displayNameUpdated: true,
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://example/avatar",
        uploadedAvatarSource: null,
        convertedAvatarFromHttp: false,
      },
      configPath: "channels.matrix.accounts.ops",
    }),
    listMatrixVerifications: respond([]),
    matrixClient,
    withAuthorizedMatrixReadTarget: vi.fn(
      async (params: {
        roomId: string;
        run: (target: { client: unknown; roomId: string }) => Promise<unknown>;
      }) => await params.run({ client: matrixClient, roomId: params.roomId.replace(/^room:/, "") }),
    ),
  };
});

for (const [modulePath, keys] of Object.entries({
  "./matrix/read-policy.js": ["withAuthorizedMatrixReadTarget"],
  "./matrix/actions/room.js": ["getMatrixMemberInfo", "getMatrixRoomInfo"],
  "./matrix/actions/reactions.js": [
    "listMatrixEmojis",
    "listMatrixReactions",
    "removeMatrixReactions",
  ],
  "./matrix/actions/pins.js": ["pinMatrixMessage", "unpinMatrixMessage", "listMatrixPins"],
  "./matrix/actions/polls.js": ["voteMatrixPoll"],
  "./matrix/actions/verification.js": ["listMatrixVerifications"],
  "./profile-update.js": ["applyMatrixProfileUpdate"],
} satisfies Record<string, (keyof typeof mocks)[]>)) {
  // mock-isolation: Adapter tests supply operations without opening real Matrix clients.
  vi.doMock(modulePath, () => Object.fromEntries(keys.map((key) => [key, mocks[key]])));
}

vi.mock("./matrix/actions/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/actions/messages.js")>()),
  deleteMatrixMessage: mocks.deleteMatrixMessage,
  editMatrixMessage: mocks.editMatrixMessage,
  readMatrixMessage: mocks.readMatrixMessage,
  readMatrixMessages: mocks.readMatrixMessages,
}));
vi.mock("./matrix/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/send.js")>()),
  reactMatrixMessage: mocks.reactMatrixMessage,
  sendMessageMatrix: mocks.sendMatrixMessage,
}));

const { matrixMessageActions } = await import("./actions.js");

export const getMatrixActionMocks = () => mocks;

export function resetMatrixActionMocks() {
  vi.resetAllMocks();
}

export function runMatrixAction(
  action: ChannelMessageActionContext["action"],
  params: Record<string, unknown>,
  cfg: CoreConfig,
  context: Partial<Omit<ChannelMessageActionContext, "channel" | "action" | "params" | "cfg">> = {},
) {
  const handleAction = matrixMessageActions.handleAction;
  if (!handleAction) {
    throw new Error("Matrix message actions are unavailable");
  }
  return handleAction({ channel: "matrix", action, params, cfg, ...context });
}
