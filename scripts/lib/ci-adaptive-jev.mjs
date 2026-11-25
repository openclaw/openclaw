import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  isObservationPath,
  observationContext,
  observationFile,
  observationFileId,
} from "./ci-test-observations.mjs";

const MODEL = "jev-1.14.0";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const BYTE_LIMIT = 64 * 1024;
const BATCH_SIZE = 25;

async function responseJson(response, controller) {
  assert(response.ok && response.body, "Provider request failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > BYTE_LIMIT) {
      controller.abort();
      throw new Error("Response exceeds budget");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Optional path-only ranking experiment. Never selects or reorders tests.
 * @param {{version: number, context: unknown, files: ReturnType<typeof observationFile>[], changedFiles: string[]}} request
 */
export async function rankAdaptiveJev(request, apiKey = process.env.TYPESAFE_API_KEY) {
  const started = performance.now();
  assert(request?.version === 1, "Unsupported ranking request");
  const context = observationContext(request.context);
  assert(Array.isArray(request.files) && request.files.length <= 1000, "Invalid inventory size");
  const files = request.files.map(observationFile);
  assert(new Set(files.map(observationFileId)).size === files.length, "Duplicate file identity");
  assert(
    Array.isArray(request.changedFiles) &&
      request.changedFiles.length <= 600 &&
      request.changedFiles.every(isObservationPath),
    "Invalid changed paths",
  );
  const changedFiles = [...new Set(request.changedFiles)].toSorted();
  const batches = [];
  for (let offset = 0; offset < files.length; offset += BATCH_SIZE) {
    const questions = Object.fromEntries(
      files.slice(offset, offset + BATCH_SIZE).map((file, index) => [
        `q${String(index).padStart(3, "0")}`,
        {
          type: "noul",
          instructions: {
            question:
              "Could the changed paths affect this test's behavior? Use path names only; no outcome evidence is available.",
            test: file,
          },
          criteria: {
            true: "A changed system could affect this test.",
            false: "The changed systems appear unrelated to this test.",
          },
        },
      ]),
    );
    const body = JSON.stringify({ model: MODEL, state: { changedFiles }, questions });
    assert(Buffer.byteLength(body) <= BYTE_LIMIT, "Ranking request exceeds byte budget");
    batches.push({ body, ids: Object.keys(questions), offset });
  }
  const result = {
    version: 1,
    mode: "experimental-ranking",
    model: MODEL,
    context,
    recordedAt: new Date().toISOString(),
    completedAt: null,
    inputSha256: createHash("sha256")
      .update(
        JSON.stringify({ version: 1, context, files, batches: batches.map(({ body }) => body) }),
      )
      .digest("hex"),
    scheduledFiles: files,
    rows: files.map(({ file, project, pool }) => ({
      file,
      project,
      pool,
      score: null,
      unknownReasons: [],
    })),
    requests: 0,
    usage: { inputTokens: 0, outputTokens: 0, complete: true },
    fallbackReason: null,
    elapsedMs: 0,
  };
  const controller = new AbortController();
  let timer;
  try {
    if (!apiKey?.trim()) {
      result.fallbackReason = "missing-api-key";
    } else {
      timer = setTimeout(() => controller.abort(), 10_000);
      timer.unref();
      for (const batch of batches) {
        result.requests += 1;
        const response = await fetch(ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: batch.body,
        });
        const data = await responseJson(response, controller);
        for (const key of ["input_tokens", "output_tokens"]) {
          assert(Number.isSafeInteger(data.usage?.[key]) && data.usage[key] >= 0, "Invalid usage");
        }
        const inputTokens = result.usage.inputTokens + data.usage.input_tokens;
        const outputTokens = result.usage.outputTokens + data.usage.output_tokens;
        assert(
          Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens),
          "Usage exceeds integer range",
        );
        result.usage.inputTokens = inputTokens;
        result.usage.outputTokens = outputTokens;
        assert(data.model === MODEL, "Mismatched model");
        assert(
          data.answers && typeof data.answers === "object" && !Array.isArray(data.answers),
          "Missing answers",
        );
        assert.deepEqual(
          Object.keys(data.answers).toSorted(),
          batch.ids.toSorted(),
          "Incomplete answers",
        );
        for (const [index, id] of batch.ids.entries()) {
          const answer = data.answers[id];
          assert(
            answer?.type === "noul" &&
              typeof answer.noul === "number" &&
              Number.isFinite(answer.noul) &&
              answer.noul >= 0 &&
              answer.noul <= 1,
            "Invalid answer",
          );
          result.rows[batch.offset + index].score = answer.noul;
        }
      }
    }
  } catch {
    controller.abort();
    result.fallbackReason = "provider-unavailable-or-invalid";
    result.usage.complete = false;
  } finally {
    clearTimeout(timer);
  }
  if (result.fallbackReason) {
    for (const row of result.rows) {
      row.score = null;
      row.unknownReasons = [result.fallbackReason];
    }
  }
  result.completedAt = new Date().toISOString();
  result.elapsedMs = performance.now() - started;
  return result;
}
