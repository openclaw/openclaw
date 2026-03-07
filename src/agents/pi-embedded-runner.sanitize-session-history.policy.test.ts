import { beforeEach, describe, expect, it, vi } from "vitest";
import * as helpers from "./pi-embedded-helpers.js";
import {
  expectGoogleModelApiFullSanitizeCall,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  makeSimpleUserMessages,
  sanitizeSnapshotChangedOpenAIReasoning,
  sanitizeWithOpenAIResponses,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";

vi.mock("./pi-embedded-helpers.js", async () => ({
  ...(await vi.importActual("./pi-embedded-helpers.js")),
  isGoogleModelApi: vi.fn(),
  sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
}));

type SanitizeSessionHistory = Awaited<ReturnType<typeof loadSanitizeSessionHistoryWithCleanMocks>>;
let sanitizeSessionHistory: SanitizeSessionHistory;

describe("sanitizeSessionHistory e2e smoke", () => {
  const mockSessionManager = makeMockSessionManager();
  const mockMessages = makeSimpleUserMessages();

  beforeEach(async () => {
    sanitizeSessionHistory = await loadSanitizeSessionHistoryWithCleanMocks();
  });

  it("applies full sanitize policy for google model APIs", async () => {
    await expectGoogleModelApiFullSanitizeCall({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });
  });

  it("keeps images-only sanitize policy without tool-call id rewriting for openai-responses", async () => {
    vi.mocked(helpers.isGoogleModelApi).mockReturnValue(false);

    await sanitizeWithOpenAIResponses({
      sanitizeSessionHistory,
      messages: mockMessages,
      sessionManager: mockSessionManager,
    });

    expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
      mockMessages,
      "session:history",
      expect.objectContaining({
        sanitizeMode: "images-only",
        sanitizeToolCallIds: false,
      }),
    );
  });

  it("downgrades openai reasoning blocks when the model snapshot changed", async () => {
    const result = await sanitizeSnapshotChangedOpenAIReasoning({
      sanitizeSessionHistory,
    });

    expect(result).toEqual([]);
  });
});
