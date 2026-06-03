// Openai tests cover embedding batch plugin behavior.
import { describe, expect, it } from "vitest";
import { parseOpenAiBatchOutput, runOpenAiEmbeddingBatches } from "./embedding-batch.js";

const jsonlEncoder = new TextEncoder();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonlBytes(value: string): number {
  return jsonlEncoder.encode(value).byteLength;
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function parseStringBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("missing JSON request body");
  }
  return JSON.parse(init.body) as unknown;
}

describe("OpenAI embedding batch output", () => {
  it("wraps malformed JSONL output", () => {
    expect(() => parseOpenAiBatchOutput('{"custom_id":"ok"}\n{not json')).toThrow(
      "OpenAI embedding batch output contained malformed JSONL",
    );
  });

  it("splits provider uploads by serialized JSONL byte cap", async () => {
    const requests: Parameters<typeof runOpenAiEmbeddingBatches>[0]["requests"] = Array.from(
      { length: 3 },
      (_, index) => ({
        custom_id: String(index),
        method: "POST" as const,
        url: "/v1/embeddings",
        body: {
          model: "text-embedding-3-small",
          input: `payload-${index}-${"β".repeat(8)}`,
        },
      }),
    );
    const uploadedJsonl: string[] = [];
    const requestsByFileId = new Map<string, Array<{ custom_id?: string }>>();
    const outputByFileId = new Map<string, string>();
    let fileIndex = 0;
    let batchIndex = 0;
    const maxJsonlBytes = jsonlBytes(JSON.stringify(requests[0]));
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        const form = init.body as FormData;
        const file = form.get("file");
        if (!(file instanceof Blob)) {
          throw new Error("missing batch upload file");
        }
        const jsonl = await file.text();
        const fileId = `file-${fileIndex}`;
        fileIndex += 1;
        uploadedJsonl.push(jsonl);
        requestsByFileId.set(
          fileId,
          jsonl.split("\n").map((line) => JSON.parse(line) as { custom_id?: string }),
        );
        return jsonResponse({ id: fileId });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        const body = parseStringBody(init) as { input_file_id?: string };
        const batchId = `batch-${batchIndex}`;
        const outputFileId = `output-${batchIndex}`;
        batchIndex += 1;
        const uploadedRequests = requestsByFileId.get(body.input_file_id ?? "") ?? [];
        outputByFileId.set(
          outputFileId,
          uploadedRequests
            .map((request) =>
              JSON.stringify({
                custom_id: request.custom_id,
                response: {
                  status_code: 200,
                  body: { data: [{ embedding: [Number(request.custom_id) + 1] }] },
                },
              }),
            )
            .join("\n"),
        );
        return jsonResponse({ id: batchId, status: "completed", output_file_id: outputFileId });
      }
      const contentMatch = url.match(/\/files\/([^/]+)\/content$/);
      if (contentMatch) {
        return new Response(outputByFileId.get(contentMatch[1] ?? "") ?? "", { status: 200 });
      }
      return new Response("unexpected request", { status: 500 });
    };

    const byCustomId = await runOpenAiEmbeddingBatches({
      openAi: {
        baseUrl: "https://openai-compatible.example/v1",
        headers: { Authorization: "Bearer test" },
        model: "text-embedding-3-small",
        fetchImpl,
      },
      agentId: "main",
      requests,
      maxJsonlBytes,
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
    });

    expect(uploadedJsonl).toHaveLength(3);
    expect(uploadedJsonl.every((jsonl) => jsonlBytes(jsonl) <= maxJsonlBytes)).toBe(true);
    expect([...byCustomId.entries()]).toEqual([
      ["0", [1]],
      ["1", [2]],
      ["2", [3]],
    ]);
  });
});
