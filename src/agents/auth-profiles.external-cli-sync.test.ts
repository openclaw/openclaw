import { beforeEach, describe, expect, it, vi } from "vitest";
import { MINIMAX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
import {
  readExternalCliBootstrapCredential,
  resolveExternalCliAuthProfiles,
} from "./auth-profiles/external-cli-sync.js";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn<() => OAuthCredential | null>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<() => OAuthCredential | null>(() => null),
}));
vi.mock("./cli-credentials.js", () => mocks);

const oauth = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  type: "oauth",
  provider: "minimax-portal",
  access: "cli-access",
  refresh: "cli-refresh",
  expires: Date.now() + 86_400_000,
  ...overrides,
});
const store = (credential?: OAuthCredential): AuthProfileStore => ({
  version: 1,
  profiles: credential ? { [MINIMAX_CLI_PROFILE_ID]: credential } : {},
});

beforeEach(() => {
  mocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(oauth({ provider: "openai" }));
  mocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
});

describe("external CLI OAuth resolution", () => {
  it("does not bootstrap an OpenAI profile from retired Codex storage", () => {
    expect(
      readExternalCliBootstrapCredential({
        store: store(),
        profileId: "openai:default",
        credential: oauth({ provider: "openai" }),
      }),
    ).toBeNull();
    expect(mocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("does not probe CLI stores outside the requested provider scope", () => {
    expect(
      resolveExternalCliAuthProfiles(store(), {
        providerIds: ["openai", "codex-app-server"],
        profileIds: ["openai:default"],
        allowKeychainPrompt: false,
      }),
    ).toEqual([]);
    expect(mocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
    expect(mocks.readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("replaces unusable MiniMax credentials with fresher CLI credentials", () => {
    const imported = oauth({ email: "user@example.test" });
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(imported);
    expect(
      resolveExternalCliAuthProfiles(
        store(
          oauth({
            access: "old-access",
            refresh: "old-refresh",
            expires: Date.now() - 5_000,
            email: "user@example.test",
          }),
        ),
      ),
    ).toEqual([
      {
        profileId: MINIMAX_CLI_PROFILE_ID,
        credential: { ...imported, authFlow: "external-cli" },
        persistence: "persisted",
      },
    ]);
  });

  it("keeps a usable local MiniMax credential even when the CLI token expires later", () => {
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(oauth());
    expect(
      resolveExternalCliAuthProfiles(
        store(
          oauth({
            access: "local-access",
            refresh: "local-refresh",
            expires: Date.now() + 600_000,
          }),
        ),
      ),
    ).toEqual([]);
  });
});
