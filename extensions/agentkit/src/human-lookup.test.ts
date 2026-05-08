import { describe, expect, it, vi } from "vitest";
import * as agentkitRuntimeModule from "./agentkit.runtime.js";
import { resolveAgentkitHumanLookup } from "./human-lookup.js";
import * as localAgentbookModule from "./local-agentbook.js";

describe("agentkit human lookup selection", () => {
  it("selects the local trust verifier when requested", () => {
    const localVerifier = { lookupHuman: vi.fn(async () => "local-human:1") };
    vi.spyOn(localAgentbookModule, "createTrustVerifiedSignerAgentBookVerifier").mockReturnValue(
      localVerifier,
    );

    const selection = resolveAgentkitHumanLookup({
      localTrustVerifiedSigner: true,
    });

    expect(selection.humanLookupMode).toBe("local-trust-verified-signer");
    expect(selection.agentBook).toBe(localVerifier);
  });

  it("uses the real AgentBook verifier by default and forwards overrides", () => {
    const realVerifier = { lookupHuman: vi.fn(async () => "0x1234") };
    const createAgentBookVerifier = vi
      .spyOn(agentkitRuntimeModule, "createAgentBookVerifier")
      .mockReturnValue(realVerifier);

    const selection = resolveAgentkitHumanLookup({
      agentBookContractAddress: "0x1111111111111111111111111111111111111111",
      agentBookRpcUrl: "https://worldchain.example/rpc",
    });

    expect(selection.humanLookupMode).toBe("agentbook");
    expect(selection.agentBook).toBe(realVerifier);
    expect(createAgentBookVerifier).toHaveBeenCalledWith({
      contractAddress: "0x1111111111111111111111111111111111111111",
      rpcUrl: "https://worldchain.example/rpc",
    });
  });

  it("rejects malformed contract addresses", () => {
    expect(() =>
      resolveAgentkitHumanLookup({
        agentBookContractAddress: "not-an-address",
      }),
    ).toThrow(/Invalid AgentBook contract address/i);
  });
});
