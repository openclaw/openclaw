import { describe, expect, it, vi } from "vitest";
import { isWhatsAppAutomationPeer } from "./targets-runtime.js";

const peer = "+15550000001";
const pn = "15550000001@s.whatsapp.net";
const lid = "100000001@lid";

describe("private reminder reply peer", () => {
  it("accepts a native phone DM without a mapping", async () => {
    await expect(isWhatsAppAutomationPeer(pn, undefined, peer)).resolves.toBe(true);
  });

  it("requires the socket's forward and inverse mapping for a LID", async () => {
    const mapping = {
      getPNForLID: vi.fn().mockResolvedValue(pn),
      getLIDForPN: vi.fn().mockResolvedValue(lid),
    };
    await expect(isWhatsAppAutomationPeer(lid, pn, peer, mapping)).resolves.toBe(true);
    expect(mapping.getPNForLID).toHaveBeenCalledWith(lid);
    expect(mapping.getLIDForPN).toHaveBeenCalledWith(pn);
    mapping.getLIDForPN.mockResolvedValue("100000003@lid");
    await expect(isWhatsAppAutomationPeer(lid, pn, peer, mapping)).resolves.toBe(false);
  });

  it.each([
    [lid, undefined],
    [pn, "15550000003@s.whatsapp.net"],
    [lid, "15550000003@s.whatsapp.net"],
    ["15550000003@s.whatsapp.net", undefined],
    ["100000001@g.us", undefined],
  ])("declines an unresolved or different peer", async (jid, alternate) => {
    await expect(isWhatsAppAutomationPeer(jid!, alternate, peer)).resolves.toBe(false);
  });
});
