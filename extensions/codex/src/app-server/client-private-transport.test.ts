import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
import { describe, expect, it } from "vitest";
import { createClientHarness } from "./test-support.js";

describe("private native transport capabilities", () => {
  it("preserves private values in internal RPC responses and server request arguments", async () => {
    const h = createClientHarness();
    const secret = generateSecureToken({ bytes: 32, redact: true });
    const address = "http://127.0.0.1:12345/" + secret + "/v1";
    h.client.protectPrivateTransportSecret(secret);
    try {
      const expected = { config: { openai_base_url: address } };
      const pending = h.client.request("config/read", {});
      const request = JSON.parse(await h.waitForWrite(0));
      h.send({ id: request.id, result: expected });
      expect(await pending).toEqual(expected);

      const received: unknown[] = [];
      h.client.addRequestHandler((incoming) => {
        received.push(incoming.params);
        return { accepted: true };
      });
      h.send({ id: "native-request", method: "fixture/request", params: { address } });
      await h.waitForWrite(1);
      expect(received).toEqual([{ address }]);
    } finally {
      await h.client.closeAndWait();
    }
  });

  it("redacts diagnostic values even across arbitrary native stderr chunks", async () => {
    const h = createClientHarness();
    const secret = generateSecureToken({ bytes: 32, redact: true });
    const address = "http://127.0.0.1:12345/" + secret + "/v1";
    h.client.protectPrivateTransportSecret(secret);
    try {
      h.process.stderr.write("private route: " + address.slice(0, address.indexOf(secret) + 31));
      expect(h.client.getStderrDiagnostic()).not.toContain(secret.slice(0, 31));
      h.process.stderr.write(address.slice(address.indexOf(secret) + 31) + " complete\n");
      expect(h.client.getStderrDiagnostic()).not.toContain(secret);
      expect(h.client.getStderrDiagnostic()).toContain("complete");
      expect(redactSensitiveText(address)).not.toContain(secret);
    } finally {
      await h.client.closeAndWait();
    }
  });
});
