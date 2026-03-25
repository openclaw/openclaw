import { describe, expect, it } from "vitest";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  resolveSlashHandlerForToken,
} from "./slash-state.js";

describe("slash-state token routing", () => {
  it("returns single match when token belongs to one account", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: { accountId: "a1" } as any,
      commandTokens: ["tok-a"],
      registeredCommands: [],
      api: { cfg: {} as any, runtime: {} as any },
    });

    const match = resolveSlashHandlerForToken("tok-a");
    expect(match.kind).toBe("single");
    expect(match.accountIds).toEqual(["a1"]);
  });

  it("returns ambiguous when same token exists in multiple accounts", () => {
    deactivateSlashCommands();
    activateSlashCommands({
      account: { accountId: "a1" } as any,
      commandTokens: ["tok-shared"],
      registeredCommands: [],
      api: { cfg: {} as any, runtime: {} as any },
    });
    activateSlashCommands({
      account: { accountId: "a2" } as any,
      commandTokens: ["tok-shared"],
      registeredCommands: [],
      api: { cfg: {} as any, runtime: {} as any },
    });

    const match = resolveSlashHandlerForToken("tok-shared");
    expect(match.kind).toBe("ambiguous");
    expect(match.accountIds?.sort()).toEqual(["a1", "a2"]);
  });
});
