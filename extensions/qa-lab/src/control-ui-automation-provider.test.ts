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

it("advances scripted creation within a single Responses turn and records only the add result", async () => {
  const provider = await startAutomationProvider();
  try {
    const input: Record<string, unknown>[] = [
      { role: "user", content: "Create a reminder. [automation-proof:create]" },
    ];
    const request = async () => {
      const response = await fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        body: JSON.stringify({ input, tools: [{ type: "function", name: "automations" }] }),
      });
      expect(response.status).toBe(200);
      const payload: { output: Record<string, unknown>[] } = await response.json();
      return payload.output;
    };
    const name = "Fixture reminder";
    const plan = { action: "plan", names: [name] };
    const add = { action: "add", job: { name, enabled: false } };
    provider.requests.set("create", [plan, add]);
    const created = JSON.stringify({ id: "fixture-job", name, enabled: false });
    for (const [args, result] of [
      [plan, '{"type":"automation_creation_plan","planId":"fixture-plan"}'],
      [add, created],
    ] as const) {
      const [call] = await request();
      if (!call) {
        throw new Error("Expected an automation tool call");
      }
      expect(call).toMatchObject({
        type: "function_call",
        name: "automations",
        arguments: JSON.stringify(args),
        call_id: expect.any(String),
      });
      expect(provider.results.has("create")).toBe(false);
      input.push(call, { type: "function_call_output", call_id: call.call_id, output: result });
    }
    expect(await request()).toMatchObject([{ type: "message", role: "assistant" }]);
    expect(provider.results.get("create")).toBe(created);
  } finally {
    await provider.stop();
  }
});
