import { beforeEach, vi } from "vitest";

const graphMessagesMockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  fetchAllGraphPages: vi.fn(),
  fetchGraphAbsoluteUrl: vi.fn(),
  mutateGraphJson: vi.fn(),
  deleteGraphRequest: vi.fn(),
  findPreferredDmByUserId: vi.fn(),
}));

vi.mock("./graph.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("./graph.js")>()),
    resolveGraphToken: graphMessagesMockState.resolveGraphToken,
    fetchGraphJson: graphMessagesMockState.fetchGraphJson,
    fetchAllGraphPages: graphMessagesMockState.fetchAllGraphPages,
    fetchGraphAbsoluteUrl: graphMessagesMockState.fetchGraphAbsoluteUrl,
    mutateGraphJson: graphMessagesMockState.mutateGraphJson,
    deleteGraphRequest: graphMessagesMockState.deleteGraphRequest,
    escapeOData: vi.fn((value: string) => value.replaceAll("'", "''")),
  };
});

vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => ({
    findPreferredDmByUserId: graphMessagesMockState.findPreferredDmByUserId,
  }),
}));

export const TOKEN = "test-graph-token";
export const CHAT_ID = "19:abc@thread.tacv2";
export const CHANNEL_TO = "team-id-1/channel-id-1";

export function getGraphMessagesMockState(): typeof graphMessagesMockState {
  return graphMessagesMockState;
}

export type GraphMessagesTestModule = typeof import("./graph-messages.js");

export function loadGraphMessagesTestModule(): Promise<GraphMessagesTestModule> {
  return import("./graph-messages.js");
}

export function installGraphMessagesMockDefaults(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    graphMessagesMockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });
}
