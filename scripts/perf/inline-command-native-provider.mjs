// Deterministic inference only: Codex, shell execution and Gateway delivery remain real.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
  PROXY_FIXTURE_SERVER_CERTIFICATE,
} from "../../src/test-helpers/proxy-tls-fixture.ts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.ts";

export async function createNativeCommandProvider(command) {
  const requests = [];
  const errors = [];
  const server = createServer(
    { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_SERVER_CERTIFICATE },
    (request, response) => {
      void (async () => {
        try {
          const endpoint = new URL(request.url, "https://127.0.0.1").pathname;
          if (request.method !== "POST" || endpoint !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const chunks = [];
          for await (const chunk of request) {
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const flatten = (tools, namespace) =>
            tools.flatMap((tool) =>
              tool.type === "namespace" ? flatten(tool.tools, tool.name) : [{ ...tool, namespace }],
            );
          const tools = flatten(body.tools ?? []);
          const result = (body.input ?? []).find(
            (item) =>
              item.type === "function_call_output" && item.call_id === "inline-native-output",
          );
          const resultText =
            typeof result?.output === "string"
              ? result.output
              : (result?.output ?? [])
                  .filter((part) => part.type === "input_text")
                  .map((part) => part.text)
                  .join("\n");
          requests.push({
            at: performance.now(),
            model: body.model,
            tools: tools.map((tool) => ({
              type: tool.type,
              name: tool.name ?? tool.function?.name,
              namespace: tool.namespace,
            })),
            commandResult: (body.input ?? []).some(
              (item) =>
                item.type === "function_call_output" && item.call_id === "inline-native-output",
            ),
          });
          if (result) {
            requests.at(-1).result = {
              bytes: Buffer.byteLength(resultText),
              sha256: createHash("sha256").update(resultText).digest("hex"),
              terminalSuccess: /^Process exited with code 0$/mu.test(resultText),
              stillRunning: resultText.includes("Process running with session ID"),
              firstMarker: resultText.includes("output-000000:"),
              lastMarker: resultText.includes("output-000511:"),
              truncationNotice: resultText.includes("truncated") || resultText.includes("omitted"),
            };
          }
          assert(requests.length <= 2, "unexpected extra inference request");
          if (requests.length === 1) {
            const tool = tools.find(
              (offered) => (offered.name ?? offered.function?.name) === "exec_command",
            );
            assert(tool, "native exec_command must be offered");
            writeOpenAiResponsesSse(response, [
              { type: "response.created", response: { id: "inline-command-response" } },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: "inline-native-output",
                  name: "exec_command",
                  ...(tool.namespace ? { namespace: tool.namespace } : {}),
                  arguments: JSON.stringify({
                    cmd: command,
                    login: false,
                    yield_time_ms: 30000,
                    max_output_tokens: 1000000,
                  }),
                },
              },
              {
                type: "response.completed",
                response: {
                  id: "inline-command-response",
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
          } else {
            const receipt = requests.at(-1);
            assert(receipt.commandResult, "Codex must return the native command result");
            assert(
              receipt.result.terminalSuccess && !receipt.result.stillRunning,
              "native command must exit zero, without a live process handle",
            );
            assert(
              receipt.result.firstMarker && receipt.result.lastMarker,
              "native result must preserve both output boundaries under its capture policy",
            );
            writeOpenAiResponsesText(response, {
              text: "INLINE_NATIVE_COMMAND_COMPLETE",
              messageId: "inline-native-answer",
              responseId: "inline-native-final",
            });
          }
        } catch (error) {
          errors.push(String(error));
          response.writeHead(500).end("Deterministic provider contract failed");
        }
      })();
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `https://127.0.0.1:${server.address().port}/v1`,
    certificate: PROXY_FIXTURE_CERTIFICATE,
    requests,
    errors,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) =>
          error
            ? reject(new Error("Native provider fixture could not close", { cause: error }))
            : resolve(),
        );
      });
    },
  };
}
