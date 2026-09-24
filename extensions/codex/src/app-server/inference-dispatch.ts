import { isUtf8 } from "node:buffer";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import type { RawData } from "openclaw/plugin-sdk/websocket-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { createCodexInferenceContext } from "./inference-context.js";
import { readCodexInferenceMetadata, type CodexInferenceMetadata } from "./inference-metadata.js";
import { createUploadBody, MAX_BODY_BYTES } from "./inference-upload.js";
import type {
  NativeModelSourceCapture,
  NativeModelSourceRequest,
} from "./native-subagent-monitor-types.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export const CODEX_INFERENCE_TRANSPORT_FAILURE =
  "Codex parent-local inference transport failed; retry on a fresh connection.";
const FAILURE = CODEX_INFERENCE_TRANSPORT_FAILURE;
const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

export type CodexInferenceModelExecution = Readonly<{
  assertCurrent: () => void;
  signal?: AbortSignal;
  release: () => void;
}>;

export type CodexInferenceModelRequest = Readonly<{
  path: string;
  body: JsonObject;
  headers: IncomingHttpHeaders;
  metadata: CodexInferenceMetadata;
  transport: "http" | "websocket";
  signal: AbortSignal;
}>;

/** Only host-owned authorization failures may cross the private transport boundary. */
export class CodexInferenceAuthorizationError extends Error {
  constructor(reason: "model" | "owner") {
    super(
      reason === "model"
        ? "Your operator role cannot use this model. Choose an allowed model or ask a gateway administrator to update your role's model policy."
        : "Codex cannot verify the owner of this model request. Start a fresh request before retrying.",
    );
  }
}

export function authorizationFailure(error: unknown): string | undefined {
  if (!(error instanceof CodexInferenceAuthorizationError)) {
    return undefined;
  }
  return JSON.stringify({
    type: "error",
    status: 403,
    error: {
      type: "invalid_request_error",
      code: "model_permission_denied",
      message: error.message,
    },
  });
}

/** The route supplies its selected provider; native custody supplies the execution's source. */
export function createCodexInferenceModelBinding(params: {
  client: CodexAppServerClient;
  provider: string;
  modelPolicyEnforced?: boolean;
  assertCurrent: () => void;
  memoryConfigured: () => boolean;
  captureModelSource: (
    request: NativeModelSourceRequest & { client: CodexAppServerClient },
  ) => Promise<NativeModelSourceCapture | undefined>;
  resolveModelThreadId: (params: {
    client: CodexAppServerClient;
    turnId: string;
  }) => string | undefined;
}) {
  const { assertCurrent: assertClient, provider } = params;
  const refuseOwner = (error: unknown, signal: AbortSignal): never => {
    signal.throwIfAborted();
    assertClient();
    throw error instanceof CodexInferenceAuthorizationError
      ? error
      : new CodexInferenceAuthorizationError("owner");
  };
  return async ({
    path,
    body,
    metadata,
    signal,
    transport,
  }: CodexInferenceModelRequest): Promise<CodexInferenceModelExecution> => {
    assertClient();
    signal.throwIfAborted();
    if (
      typeof body.model !== "string" ||
      !body.model.trim() ||
      (transport === "websocket" &&
        (body.type !== "response.create" ||
          !["/responses", "/guardian", "/guardian-classifier"].includes(path))) ||
      ![
        "/responses",
        "/responses/compact",
        "/alpha/search",
        "/images/generations",
        "/images/edits",
        "/guardian",
        "/guardian-classifier",
      ].includes(path)
    ) {
      throw new CodexInferenceAuthorizationError("owner");
    }
    const reviewer =
      metadata.subagent === "guardian" && metadata.threadSource === "guardian_review";
    const classifier =
      metadata.subagent === "guardian" && metadata.threadSource === "guardian_classifier";
    if (
      (path === "/guardian" && !reviewer) ||
      (path === "/guardian-classifier" && !classifier) ||
      (path === "/responses/compact" && metadata.requestKind !== "compaction")
    ) {
      throw new CodexInferenceAuthorizationError("owner");
    }
    if (path === "/responses" && metadata.requestKind === "prewarm" && body.generate === false) {
      return { assertCurrent: assertClient, release: () => {} };
    }
    const memory =
      metadata.threadSource === "memory_consolidation" &&
      (metadata.requestKind === "memory" || metadata.subagent === "memory_consolidation");
    if (memory && params.memoryConfigured() && path === "/responses") {
      return { assertCurrent: assertClient, release: () => {} };
    }
    const parentExecution = reviewer || classifier || metadata.subagent === "review";
    const imageTurnId = metadata.nativeImageTurnId;
    const threadId = imageTurnId
      ? params.resolveModelThreadId({ client: params.client, turnId: imageTurnId })
      : parentExecution
        ? classifier
          ? metadata.guardianClassifierSourceThreadId
          : metadata.parentThreadId
        : metadata.threadId;
    const turnId = imageTurnId ?? (parentExecution ? metadata.parentTurnId : metadata.turnId);
    if (!threadId || !turnId || memory) {
      throw new CodexInferenceAuthorizationError("owner");
    }
    let acquired: NativeModelSourceCapture | undefined;
    try {
      acquired = await params.captureModelSource({
        client: params.client,
        threadId,
        turnId,
        ...(parentExecution
          ? { rootTurnId: metadata.rootTurnId }
          : {
              parentThreadId: metadata.parentThreadId,
              parentTurnId: metadata.parentTurnId,
              rootTurnId: metadata.rootTurnId,
            }),
        signal,
      });
    } catch (error) {
      refuseOwner(error, signal);
    }
    if (!acquired) {
      throw new CodexInferenceAuthorizationError("owner");
    }
    const captured = acquired;
    // Native Images failures return to the still-allowed parent; its turn owns other models too.
    const cancelNativeTurn = () => {
      if (!imageTurnId) {
        captured.cancel();
      }
    };
    let model: ReturnType<NonNullable<NonNullable<typeof captured.source>["bindModelExecution"]>>;
    let releaseAbort = () => {};
    try {
      captured.assertCurrent();
      signal.throwIfAborted();
      assertClient();
      if (reviewer || classifier) {
        if (!captured.nativeReviewRequired) {
          throw new CodexInferenceAuthorizationError("owner");
        }
      } else if (captured.source) {
        const bind = captured.source.bindModelExecution;
        if (!bind) {
          throw new CodexInferenceAuthorizationError("owner");
        }
        try {
          const mapping = captured.modelMapping;
          model = bind(
            params.modelPolicyEnforced === false
              ? undefined
              : mapping?.nativeModel.provider === provider &&
                  mapping.nativeModel.model === body.model
                ? mapping.authorizedModel
                : { provider, model: body.model },
          );
        } catch {
          cancelNativeTurn();
          throw new CodexInferenceAuthorizationError("model");
        }
        if (!model) {
          throw new CodexInferenceAuthorizationError("owner");
        }
        const revoke = cancelNativeTurn;
        model?.signal.addEventListener("abort", revoke, { once: true });
        releaseAbort = () => model?.signal.removeEventListener("abort", revoke);
        if (model?.signal.aborted) {
          revoke();
        }
      }
      if (!parentExecution) {
        captured.recordNativeReviewRequirement(
          metadata.autoReviewEnabled === true || metadata.nodeReplAutoReviewRequired === true,
        );
      }
      const assertExecution = () => {
        assertClient();
        try {
          captured.assertCurrent();
          model?.assertCurrent();
        } catch (error) {
          refuseOwner(error, signal);
        }
      };
      assertExecution();
      return {
        assertCurrent: assertExecution,
        signal: model?.signal ?? captured.source?.signal,
        release: () => {
          releaseAbort();
          model?.release();
          captured.release();
        },
      };
    } catch (error) {
      releaseAbort();
      model?.release();
      captured.release();
      return refuseOwner(error, signal);
    }
  };
}

/** One preparation path binds both HTTP requests and reusable WebSocket frames. */
export function createCodexInferenceDispatch(params: {
  context: ReturnType<typeof createCodexInferenceContext>;
  assertCurrent: () => void;
  bindModelExecution?: (
    request: CodexInferenceModelRequest,
  ) => Promise<CodexInferenceModelExecution> | CodexInferenceModelExecution;
}) {
  const { context, assertCurrent } = params;
  const prepare = async (
    bytes: Buffer,
    sampling: boolean,
    path: string,
    headers: IncomingHttpHeaders,
    signal: AbortSignal,
    transport: "http" | "websocket",
  ) => {
    assertCurrent();
    let execution: CodexInferenceModelExecution | undefined;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        execution?.release();
      }
    };
    try {
      const value: unknown =
        sampling || params.bindModelExecution ? JSON.parse(bytes.toString("utf8")) : undefined;
      if ((sampling || params.bindModelExecution) && !isJsonObject(value)) {
        throw new Error(FAILURE);
      }
      let metadata: CodexInferenceMetadata | undefined;
      if (isJsonObject(value)) {
        try {
          metadata = readCodexInferenceMetadata(value, headers, transport, path);
        } catch (error) {
          if (params.bindModelExecution) {
            throw new CodexInferenceAuthorizationError("owner");
          }
          throw error;
        }
        execution = await params.bindModelExecution?.({
          path,
          body: value,
          headers,
          metadata,
          transport,
          signal,
        });
      }
      signal.throwIfAborted();
      // Instruction injection remains parent-only, independently of model authorization.
      const prepared =
        sampling && isJsonObject(value) ? context.prepare(value, metadata) : undefined;
      const assertPrepared = () => {
        if (released) {
          throw new Error(FAILURE);
        }
        assertCurrent();
        signal.throwIfAborted();
        prepared?.assertCurrent();
        execution?.assertCurrent();
      };
      assertPrepared();
      // Preserve native bytes when instruction preparation left valid UTF-8 unchanged.
      const rewritten =
        prepared && (prepared.body !== value || !isUtf8(bytes))
          ? Buffer.from(JSON.stringify(prepared.body))
          : bytes;
      if (rewritten.length > MAX_BODY_BYTES) {
        throw new Error(FAILURE);
      }
      const requestSignal = AbortSignal.any([
        signal,
        ...(prepared?.signal ? [prepared.signal] : []),
        ...(execution?.signal ? [execution.signal] : []),
      ]);
      return {
        bytes: rewritten,
        assertCurrent: assertPrepared,
        signal: requestSignal,
        contextSignal: prepared?.signal,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  };
  const prepareHttp = async (
    req: IncomingMessage,
    sampling: boolean,
    path: string,
    signal: AbortSignal,
    release: () => void,
  ) => {
    const wire = await readProxyBody(req, MAX_BODY_BYTES);
    const encoding = req.headers["content-encoding"];
    if (encoding && encoding !== "identity" && encoding !== "zstd") {
      throw new Error(FAILURE);
    }
    const decoded =
      encoding === "zstd" ? await decompress(wire, { maxOutputLength: MAX_BODY_BYTES }) : wire;
    signal.throwIfAborted();
    const prepared = await prepare(decoded, sampling, path, req.headers, signal, "http");
    try {
      const body =
        prepared.bytes === decoded
          ? wire
          : encoding === "zstd"
            ? await compress(prepared.bytes)
            : prepared.bytes;
      prepared.assertCurrent();
      return {
        ...createUploadBody(body, prepared.signal, release),
        assertCurrent: prepared.assertCurrent,
        signal: prepared.signal,
        releaseModelExecution: prepared.release,
      };
    } catch (error) {
      prepared.release();
      throw error;
    }
  };
  return { prepare, prepareHttp };
}

export async function readProxyBody(stream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new Error(FAILURE);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function readProxyWebSocketBody(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
}

export function isTerminalResponse(bytes: Buffer): boolean {
  try {
    const event: unknown = JSON.parse(bytes.toString("utf8"));
    return (
      isJsonObject(event) &&
      (event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        (event.type === "response.completed" &&
          isJsonObject(event.response) &&
          typeof event.response.id === "string"))
    );
  } catch {
    return false;
  }
}
