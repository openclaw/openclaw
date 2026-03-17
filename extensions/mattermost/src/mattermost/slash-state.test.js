import { describe, expect, it } from "vitest";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  resolveSlashHandlerForToken
} from "./slash-state.js";
describe("slash-state token routing", () => {
  it("returns single match when token belongs to one account", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: { accountId: "a1" },
      commandTokens: ["tok-a"],
      registeredCommands: [],
      api: { cfg: {}, runtime: {} }
    });
    const match = resolveSlashHandlerForToken("tok-a");
    expect(match.kind).toBe("single");
    expect(match.accountIds).toEqual(["a1"]);
  });
  it("returns ambiguous when same token exists in multiple accounts", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: { accountId: "a1" },
      commandTokens: ["tok-shared"],
      registeredCommands: [],
      api: { cfg: {}, runtime: {} }
    });
    activateSlashCommands({
      account: { accountId: "a2" },
      commandTokens: ["tok-shared"],
      registeredCommands: [],
      api: { cfg: {}, runtime: {} }
    });
    const match = resolveSlashHandlerForToken("tok-shared");
    expect(match.kind).toBe("ambiguous");
    expect(match.accountIds?.sort()).toEqual(["a1", "a2"]);
  });
});
