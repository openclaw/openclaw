// Shared public-entry Matrix action fixture; module mocks precede the runtime import.
import { vi } from "vitest";
import type { ChannelMessageActionContext } from "../runtime-api.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  voteMatrixPoll: vi.fn(),
  reactMatrixMessage: vi.fn(),
  editMatrixMessage: vi.fn(),
  deleteMatrixMessage: vi.fn(),
  readMatrixMessages: vi.fn(),
  listMatrixEmojis: vi.fn(),
  listMatrixReactions: vi.fn(),
  removeMatrixReactions: vi.fn(),
  sendMatrixMessage: vi.fn(),
  pinMatrixMessage: vi.fn(),
  unpinMatrixMessage: vi.fn(),
  listMatrixPins: vi.fn(),
  getMatrixMemberInfo: vi.fn(),
  getMatrixRoomInfo: vi.fn(),
  applyMatrixProfileUpdate: vi.fn(),
  listMatrixVerifications: vi.fn(),
  matrixClient: { id: "matrix-client" },
  withAuthorizedMatrixReadTarget: vi.fn(),
}));

vi.mock("./matrix/read-policy.js", () => ({
  withAuthorizedMatrixReadTarget: mocks.withAuthorizedMatrixReadTarget,
}));

vi.mock("./matrix/actions.js", () => {
  return {
    deleteMatrixMessage: mocks.deleteMatrixMessage,
    editMatrixMessage: mocks.editMatrixMessage,
    getMatrixMemberInfo: mocks.getMatrixMemberInfo,
    getMatrixRoomInfo: mocks.getMatrixRoomInfo,
    listMatrixEmojis: mocks.listMatrixEmojis,
    listMatrixReactions: mocks.listMatrixReactions,
    pinMatrixMessage: mocks.pinMatrixMessage,
    unpinMatrixMessage: mocks.unpinMatrixMessage,
    listMatrixPins: mocks.listMatrixPins,
    removeMatrixReactions: mocks.removeMatrixReactions,
    readMatrixMessages: mocks.readMatrixMessages,
    sendMatrixMessage: mocks.sendMatrixMessage,
    voteMatrixPoll: mocks.voteMatrixPoll,
    listMatrixVerifications: mocks.listMatrixVerifications,
  };
});

vi.mock("./matrix/send.js", () => {
  return {
    reactMatrixMessage: mocks.reactMatrixMessage,
  };
});

vi.mock("./profile-update.js", () => ({
  applyMatrixProfileUpdate: (...args: unknown[]) => mocks.applyMatrixProfileUpdate(...args),
}));

// Load the adapter only after its lower-operation and read-policy mocks are registered.
const { matrixMessageActions } = await import("./actions.js");

export function getMatrixActionMocks() {
  return mocks;
}

export function resetMatrixActionMocks() {
  vi.clearAllMocks();
  mocks.withAuthorizedMatrixReadTarget.mockImplementation(
    async (params: {
      roomId: string;
      run: (target: { client: unknown; roomId: string }) => Promise<unknown>;
    }) =>
      await params.run({
        client: mocks.matrixClient,
        roomId: params.roomId.replace(/^room:/, ""),
      }),
  );
  mocks.voteMatrixPoll.mockResolvedValue({
    eventId: "evt-poll-vote",
    roomId: "!room:example",
    pollId: "$poll",
    answerIds: ["a1", "a2"],
    labels: ["Pizza", "Sushi"],
    maxSelections: 2,
  });
  mocks.listMatrixReactions.mockResolvedValue([{ key: "👍", count: 1, users: ["@u:example"] }]);
  mocks.listMatrixEmojis.mockResolvedValue([
    { name: "party", identifier: "party", url: "mxc://example.org/party" },
  ]);
  mocks.listMatrixPins.mockResolvedValue({ pinned: ["$pin"], events: [] });
  mocks.pinMatrixMessage.mockResolvedValue({ pinned: ["$existing", "$pin"] });
  mocks.unpinMatrixMessage.mockResolvedValue({ pinned: ["$existing"] });
  mocks.removeMatrixReactions.mockResolvedValue({ removed: 1 });
  mocks.listMatrixVerifications.mockResolvedValue([]);
  mocks.readMatrixMessages.mockResolvedValue({
    messages: [{ eventId: "$message" }],
    nextBatch: "next",
  });
  mocks.sendMatrixMessage.mockResolvedValue({
    messageId: "$sent",
    roomId: "!room:example",
  });
  mocks.editMatrixMessage.mockResolvedValue({ eventId: "$edited" });
  mocks.getMatrixMemberInfo.mockResolvedValue({ userId: "@u:example" });
  mocks.getMatrixRoomInfo.mockResolvedValue({ roomId: "!room:example" });
  mocks.applyMatrixProfileUpdate.mockResolvedValue({
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
  });
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
