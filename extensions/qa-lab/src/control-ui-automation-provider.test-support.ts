import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { inspect } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.ts";
import { hasToolDefinition } from "./providers/mock-openai/mock-openai-directives.ts";
import { buildAssistantEvents } from "./providers/mock-openai/mock-openai-events.ts";
import {
  extractLastUserText,
  extractToolOutput,
  hasToolOutput,
} from "./providers/mock-openai/mock-openai-input.ts";
import { buildToolCallEventsWithArgs } from "./providers/mock-openai/mock-openai-tooling.ts";

export async function startAutomationProvider() {
  const requests = new Map<string, Record<string, unknown>>();
  const results = new Map<string, string>();
  const toolAvailability = new Map<string, boolean>();
  const observedRequests: { marker: string | null; inputTypes: unknown[]; hasOutput: boolean }[] =
    [];
  const failures: Array<{
    method: string | undefined;
    url: string | undefined;
    marker: string | null;
    error: unknown;
  }> = [];
  let restartHold: { marker: string; recovering: boolean; reached: boolean } | undefined;
  const server = createServer((request, response) => {
    let marker: string | undefined;
    void (async () => {
      const bytes = await buffer(request);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(body) || !Array.isArray(body.input)) {
        throw new Error("Expected a Responses request");
      }
      const input = body.input.filter(isRecord);
      marker =
        /\[automation-proof:([a-z-]+)\]/u.exec(extractLastUserText(input))?.[1] ??
        (restartHold && JSON.stringify(input).includes(`[automation-proof:${restartHold.marker}]`)
          ? restartHold.marker
          : undefined);
      if (restartHold && marker === restartHold.marker && !restartHold.recovering) {
        restartHold.reached = true;
        // The original request remains effect-free until its owned Gateway dies.
        // Closing that connection releases the hold; no response is replayed.
        await new Promise<void>((resolve) => {
          response.once("close", resolve);
        });
        return;
      }
      const args = marker ? requests.get(marker) : undefined;
      const output = extractToolOutput(input);
      const hasOutput = hasToolOutput(input);
      const toolAvailable = hasToolDefinition(body, "automations");
      const inputTypes = input.map((item) => item.type ?? item.role);
      observedRequests.push({ marker: marker ?? null, inputTypes, hasOutput });
      if (marker && args && !hasOutput) {
        // A retry must not erase an earlier exposure of an owner-only tool.
        toolAvailability.set(marker, toolAvailability.get(marker) === true || toolAvailable);
      }
      if (marker && args && hasOutput) {
        results.set(marker, output);
      }
      const reply =
        marker && args
          ? `${marker}:\n\n\`\`\`json\n${output}\n\`\`\``
          : "Scheduled reminder completed.";
      const events =
        args && !hasOutput
          ? toolAvailable
            ? buildToolCallEventsWithArgs("automations", args)
            : buildAssistantEvents(`${marker}: Automation tools are unavailable for this caller.`)
          : buildAssistantEvents(reply);
      const streaming = body.stream === true;
      const contentType = streaming ? "text/event-stream" : "application/json";
      const payload = streaming
        ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
        : JSON.stringify(events.find((event) => event.type === "response.completed")?.response);
      response.writeHead(200, { "content-type": contentType }).end(payload);
    })().catch((error: unknown) => {
      failures.push({ method: request.method, url: request.url, marker: marker ?? null, error });
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  const port = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    results,
    toolAvailability,
    diagnostics: (marker: string) => ({
      marker,
      matchingInitialRequestObserved: toolAvailability.has(marker),
      automationsToolAvailable: toolAvailability.get(marker) ?? null,
      resultReceived: results.has(marker),
      observedRequests,
      providerErrors: failures.map((failure) =>
        Object.assign({}, failure, { error: redactQaGatewayDebugText(inspect(failure.error)) }),
      ),
    }),
    holdInitialRequestForRestart: (marker: string): NonNullable<typeof restartHold> =>
      (restartHold = { marker, recovering: false, reached: false }),
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
