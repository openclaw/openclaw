import { createServer } from "node:http";
import { inspect } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.ts";
import { hasToolDefinition } from "./providers/mock-openai/mock-openai-directives.ts";
import { buildAssistantEvents } from "./providers/mock-openai/mock-openai-events.ts";
import {
  extractLastUserText,
  extractToolOutput,
  hasToolOutput,
} from "./providers/mock-openai/mock-openai-input.ts";
import { buildToolCallEventsWithArgs } from "./providers/mock-openai/mock-openai-tooling.ts";

const scheduledReply = "Scheduled reminder completed.";
const makeRestartCheckpoint = (marker: string) => ({ marker, recovering: false, reached: false });

export async function startAutomationProvider() {
  const requests = new Map<string, Record<string, unknown>>();
  const results = new Map<string, string>();
  const toolAvailability = new Map<string, boolean>();
  const observedRequests: Array<{
    marker: string | null;
    inputTypes: unknown[];
    hasOutput: boolean;
  }> = [];
  const failures: Array<{
    method: string | undefined;
    url: string | undefined;
    marker: string | null;
    error: unknown;
  }> = [];
  let restartHold: ReturnType<typeof makeRestartCheckpoint> | undefined;
  const server = createServer((request, response) => {
    let marker: string | undefined;
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body) || !Array.isArray(body.input)) {
        throw new Error("Expected a Responses request");
      }
      const input = body.input.filter(isRecord);
      const userText = extractLastUserText(input);
      const markerPattern = /\[automation-proof:([a-z-]+)\]/u;
      marker =
        markerPattern.exec(userText)?.[1] ??
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
      observedRequests.push({
        marker: marker ?? null,
        inputTypes: input.map((item) => item.type ?? item.role),
        hasOutput,
      });
      if (marker && args && !hasOutput) {
        // A retry must not erase an earlier exposure of an owner-only tool.
        toolAvailability.set(marker, toolAvailability.get(marker) === true || toolAvailable);
      }
      if (marker && args && hasOutput) {
        results.set(marker, output);
      }
      const events =
        args && !hasOutput
          ? toolAvailable
            ? buildToolCallEventsWithArgs("automations", args)
            : buildAssistantEvents(`${marker}: Automation tools are unavailable for this caller.`)
          : buildAssistantEvents(
              marker && args ? `${marker}:\n\n\`\`\`json\n${output}\n\`\`\`` : scheduledReply,
            );
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } else {
        const completed = events.find((event) => event.type === "response.completed");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(completed?.response));
      }
    })().catch((error: unknown) => {
      failures.push({ method: request.method, url: request.url, marker: marker ?? null, error });
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Automation provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    results,
    toolAvailability,
    diagnostics(marker: string) {
      return {
        marker,
        matchingInitialRequestObserved: toolAvailability.has(marker),
        automationsToolAvailable: toolAvailability.get(marker) ?? null,
        resultReceived: results.has(marker),
        observedRequests,
        providerErrors: failures.map(({ method, url, marker: requestMarker, error }) => ({
          method,
          url,
          marker: requestMarker,
          error: redactQaGatewayDebugText(inspect(error)),
        })),
      };
    },
    holdInitialRequestForRestart(marker: string) {
      return (restartHold = makeRestartCheckpoint(marker));
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
