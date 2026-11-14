import {
  buildBedrockEmbeddingBody,
  buildCohereEmbeddingBody,
  buildGeminiEmbeddingRequest,
  isGeminiEmbedding2Model,
  readBedrockSingleEmbedding,
  readCohereEmbeddingBatch,
  readGeminiBatchEmbeddings,
  readGeminiEmbeddingValues,
  resolveBedrockEmbeddingSpec,
  resolveGeminiOutputDimensionality,
  sanitizeGeminiEmbedding,
} from "openclaw/plugin-sdk/embedding-native-runtime";
import type {
  EmbeddingInput,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingUsage,
} from "openclaw/plugin-sdk/embedding-providers";
import { sanitizeAndNormalizeEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";

export type NativeEmbeddingRequest = {
  offer: ClawRouterCapabilityOffer;
  body: Record<string, unknown>;
  pathParams?: { model: string };
  read: (payload: Record<string, unknown>) => number[][];
  usage: (payload: Record<string, unknown>) => EmbeddingUsage | undefined;
  maxResponseBytes: number;
};

export function embeddingRole(
  options: EmbeddingProviderCreateOptions,
  call?: EmbeddingProviderCallOptions,
) {
  const role = call?.inputType ?? options.inputType ?? "document";
  if (role !== "query" && role !== "document") {
    throw new Error("ClawRouter embeddings require a qualified query or document input type");
  }
  const configured = role === "query" ? options.queryInputType : options.documentInputType;
  if (configured && configured !== role) {
    throw new Error("ClawRouter embeddings do not translate unqualified input-type overrides");
  }
  return role;
}

function textInputs(inputs: EmbeddingInput[]): string[] {
  return inputs.map((input) => {
    if (typeof input === "string") {
      return input;
    }
    if (input.parts?.some((part) => part.type !== "text")) {
      throw new Error("This ClawRouter embedding offer accepts text-only inputs");
    }
    return (
      input.parts?.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? input.text
    );
  });
}

function usage(value: unknown): EmbeddingUsage | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { promptTokens: value, totalTokens: value }
    : undefined;
}

function validateVectors(vectors: number[][], count: number, dimensions: number): number[][] {
  if (
    vectors.length !== count ||
    vectors.some((row) => row.length !== dimensions || row.some((n) => !Number.isFinite(n)))
  ) {
    throw new Error("ClawRouter embedding count or dimensions do not match the admitted request");
  }
  return vectors.map(sanitizeAndNormalizeEmbedding);
}

export function prepareNativeEmbeddingRequests(
  offers: ClawRouterCapabilityOffer[],
  model: string,
  inputs: EmbeddingInput[],
  options: EmbeddingProviderCreateOptions,
  call?: EmbeddingProviderCallOptions,
): NativeEmbeddingRequest[] {
  const role = embeddingRole(options, call);
  const supported = new Set([
    "cohere.embed",
    "aws_bedrock.invoke",
    "google.embed_content",
    "google.batch_embed_contents",
  ]);
  const candidates = offers.filter(
    (offer) =>
      offer.model?.id === model &&
      offer.methods.includes("POST") &&
      offer.routeKind !== "unified" &&
      offer.requestFormat === offer.responseFormat &&
      supported.has(offer.requestFormat) &&
      Array.isArray(offer.model.capabilities) &&
      offer.model.capabilities.includes("llm.embeddings"),
  );
  // Prefer the bounded synchronous batch contract when it is actually offered.
  const offer =
    candidates.find((row) => row.requestFormat === "google.batch_embed_contents") ?? candidates[0];
  const upstream = offer?.model?.upstream;
  if (!offer || typeof upstream !== "string" || !upstream) {
    throw new Error("ClawRouter has no eligible native embedding offer for this model");
  }
  const requests: NativeEmbeddingRequest[] = [];
  const encode = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload));
  if (offer.requestFormat.startsWith("google.")) {
    if (
      !["gemini-embedding-001", "gemini-embedding-2", "gemini-embedding-2-preview"].includes(
        upstream,
      )
    ) {
      throw new Error("Unknown Google embedding model");
    }
    const taskType =
      options.taskType ?? (role === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT");
    if (
      ![
        "RETRIEVAL_QUERY",
        "RETRIEVAL_DOCUMENT",
        "SEMANTIC_SIMILARITY",
        "CLASSIFICATION",
        "CLUSTERING",
        "QUESTION_ANSWERING",
        "FACT_VERIFICATION",
      ].includes(taskType)
    ) {
      throw new Error("Unsupported Google embedding task type");
    }
    const dimensions = resolveGeminiOutputDimensionality(upstream, options.dimensions) ?? 3072;
    const batch = offer.requestFormat === "google.batch_embed_contents";
    const items = inputs.map((input) => {
      if (typeof input !== "string" && input.parts) {
        if (!input.parts.length || input.parts.length > 100) {
          throw new Error("Invalid Google embedding parts");
        }
        for (const part of input.parts) {
          if (
            part.type === "inline-data" &&
            (!isGeminiEmbedding2Model(upstream) ||
              !/^(?:(?:image|audio|video)\/[a-z0-9.+-]{1,64}|application\/pdf)$/u.test(
                part.mimeType,
              ) ||
              !part.data.length ||
              part.data.length % 4 !== 0 ||
              !/^[A-Za-z0-9+/]+={0,2}$/u.test(part.data))
          ) {
            throw new Error("This Google embedding offer does not support these multimodal parts");
          }
        }
      }
      return buildGeminiEmbeddingRequest({
        input,
        model: upstream,
        role,
        taskType,
        outputDimensionality: dimensions,
        ...(batch ? { modelPath: "models/" + upstream } : {}),
        queryInstructionApplied: call?.queryInstructionApplied,
        documentFormatApplied: call?.documentFormatApplied,
      });
    });
    for (let i = 0; i < items.length; i += batch ? 100 : 1) {
      const group = items.slice(i, i + (batch ? 100 : 1));
      requests.push({
        offer,
        body: batch ? { requests: group } : { ...group[0] },
        pathParams: { model: upstream },
        maxResponseBytes: 16 * 1024 * 1024,
        read: (payload) => {
          const vectors = batch
            ? readGeminiBatchEmbeddings(payload, group.length)
            : [readGeminiEmbeddingValues(payload.embedding)];
          return vectors.map((values) => sanitizeGeminiEmbedding(values, dimensions));
        },
        usage: (payload) => usage(asOptionalRecord(payload.usageMetadata)?.promptTokenCount),
      });
    }
  } else {
    if (options.taskType) {
      throw new Error("This native embedding format does not support taskType");
    }
    const texts = textInputs(inputs);
    if (texts.some((text) => !text.trim())) {
      throw new Error("Native embedding inputs must be nonempty");
    }
    const directCohere = offer.requestFormat === "cohere.embed";
    if (directCohere && upstream !== "embed-v4.0") {
      throw new Error("Unknown Cohere embedding model");
    }
    const spec = resolveBedrockEmbeddingSpec(directCohere ? "cohere.embed-v4:0" : upstream);
    if (!spec) {
      throw new Error("Unknown Bedrock embedding family");
    }
    const dimensions = options.dimensions ?? spec.dims;
    if (!(spec.validDims ?? [spec.dims]).includes(dimensions)) {
      throw new Error("Invalid native embedding dimensions");
    }
    const cohere = spec.family === "cohere-v3" || spec.family === "cohere-v4";
    for (let i = 0; i < texts.length; i += cohere ? 96 : 1) {
      const group = texts.slice(i, i + (cohere ? 96 : 1));
      const body =
        spec.family === "cohere-v3" || spec.family === "cohere-v4"
          ? buildCohereEmbeddingBody(
              spec.family,
              group,
              role === "query" ? "search_query" : "search_document",
              dimensions,
            )
          : asOptionalRecord(
              JSON.parse(buildBedrockEmbeddingBody(spec.family, group[0] ?? "", dimensions)),
            );
      if (!body) {
        throw new Error("Invalid native embedding body");
      }
      if (directCohere) {
        Object.assign(body, { model: upstream, truncate: "END" });
      }
      requests.push({
        offer,
        body,
        maxResponseBytes: 8 * 1024 * 1024,
        read: (payload) => {
          if (payload.error !== undefined) {
            throw new Error("Native embedding returned an error");
          }
          if (
            spec.family === "nova" &&
            (!Array.isArray(payload.embeddings) || payload.embeddings.length !== 1)
          ) {
            throw new Error("Invalid Nova embedding count");
          }
          if (
            (spec.family === "marengo-2" || spec.family === "marengo-3") &&
            Array.isArray(payload.data) &&
            payload.data.length !== 1
          ) {
            throw new Error("Invalid Marengo embedding count");
          }
          const raw = encode(payload);
          const vectors = cohere
            ? readCohereEmbeddingBatch(spec.family, raw)
            : [readBedrockSingleEmbedding(spec.family, raw)];
          return validateVectors(vectors, group.length, dimensions);
        },
        usage: (payload) =>
          directCohere
            ? usage(asOptionalRecord(asOptionalRecord(payload.meta)?.billed_units)?.input_tokens)
            : spec.family === "titan-v1" || spec.family === "titan-v2"
              ? usage(payload.inputTextTokenCount)
              : undefined,
      });
    }
  }
  // Validate every planned request before allowing any native POST.
  for (const request of requests) {
    const limit = request.offer.requestFormat.startsWith("google.")
      ? 20 * 1024 * 1024
      : 2 * 1024 * 1024;
    if (encode(request.body).byteLength > limit) {
      throw new Error("Native embedding request exceeds its byte limit");
    }
  }
  return requests;
}
