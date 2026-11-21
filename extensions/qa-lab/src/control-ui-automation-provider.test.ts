import { expect, it } from "vitest";
import { startAutomationProvider } from "./control-ui-automation-provider.test-support.ts";

it("retains original Responses failures and their request markers for automation diagnostics", async () => {
  const provider = await startAutomationProvider();
  try {
    const malformed = await fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(500);
    await malformed.text();

    // Force a response-construction failure after the request marker is known.
    provider.requests.set("admin-update", { unsupported: 1n });
    const failedResponse = await fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      body: JSON.stringify({
        input: [{ role: "user", content: "Update [automation-proof:admin-update]" }],
        tools: [{ type: "function", name: "automations" }],
        stream: true,
      }),
    });
    expect(failedResponse.status).toBe(500);
    await failedResponse.text();

    const diagnostics = provider.diagnostics("admin-update");
    expect(diagnostics).toMatchObject({
      marker: "admin-update",
      matchingInitialRequestObserved: true,
      resultReceived: false,
      providerErrors: [
        {
          method: "POST",
          url: "/v1/responses",
          marker: null,
          error: expect.stringContaining("SyntaxError"),
        },
        {
          method: "POST",
          url: "/v1/responses",
          marker: "admin-update",
          error: expect.stringContaining("BigInt"),
        },
      ],
    });
    expect(diagnostics.providerErrors[1]?.error).toContain("buildMockFunctionCall");
  } finally {
    await provider.stop();
  }
});
