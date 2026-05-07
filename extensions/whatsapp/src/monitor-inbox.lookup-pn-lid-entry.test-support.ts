// Whatsapp plugin module implements monitor inbox.lookup-pn-lid-entry support behavior.
import "./monitor-inbox.test-harness.js";
import { describe, expect, it } from "vitest";
import {
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
} from "./monitor-inbox.test-harness.js";

installWebMonitorInboxUnitTestHooks();

describe("lookupPnLidEntry", () => {
  it("resolves @lid JID via lidLookup.getPNForLID", async () => {
    const { listener, sock } = await startInboxMonitor(async () => {});
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(
      "12345678901@s.whatsapp.net",
    );
    const result = await listener.lookupPnLidEntry("123@lid");
    expect(result).toEqual({
      lid: "123@lid",
      phoneNumber: "+12345678901",
      contact: undefined,
    });
    await listener.close();
  });

  it("resolves @hosted.lid JID via lidLookup.getPNForLID", async () => {
    const { listener, sock } = await startInboxMonitor(async () => {});
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(
      "447700900123@s.whatsapp.net",
    );
    const result = await listener.lookupPnLidEntry("abc@hosted.lid");
    expect(result).toEqual({
      lid: "abc@hosted.lid",
      phoneNumber: "+447700900123",
      contact: undefined,
    });
    await listener.close();
  });

  it("resolves phone JID directly without lidLookup", async () => {
    const { listener } = await startInboxMonitor(async () => {});
    const result = await listener.lookupPnLidEntry("12345678901@s.whatsapp.net");
    expect(result).toEqual({
      lid: "",
      phoneNumber: "+12345678901",
      contact: undefined,
    });
    await listener.close();
  });

  it("resolves plain E.164 number", async () => {
    const { listener } = await startInboxMonitor(async () => {});
    const result = await listener.lookupPnLidEntry("+12345678901");
    expect(result).toEqual({
      lid: "",
      phoneNumber: "+12345678901",
      contact: undefined,
    });
    await listener.close();
  });
});
