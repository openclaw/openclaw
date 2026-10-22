/**
 * A2A 1.0 error surface.
 *
 * The specification pairs every JSON-RPC error code with a `google.rpc.ErrorInfo`
 * detail (`docs/specification.md` §3.3.2 / §5.4). Peers are expected to branch on
 * that stable `reason` rather than parse the human-readable `message`, so every
 * A2A-specific failure below carries one.
 */

export const A2A_JSON_RPC_ERROR_CODES = {
  // JSON-RPC 2.0 reserved codes.
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A-specific codes. The specification reserves -32001 through -32099.
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  EXTENDED_CARD_NOT_CONFIGURED: -32007,
  EXTENSION_SUPPORT_REQUIRED: -32008,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

export type A2aJsonRpcErrorCode =
  (typeof A2A_JSON_RPC_ERROR_CODES)[keyof typeof A2A_JSON_RPC_ERROR_CODES];

/** `google.rpc.ErrorInfo.reason` values, one per A2A-specific error type. */
export type A2aErrorReason =
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CANCELABLE"
  | "PUSH_NOTIFICATION_NOT_SUPPORTED"
  | "UNSUPPORTED_OPERATION"
  | "CONTENT_TYPE_NOT_SUPPORTED"
  | "INVALID_AGENT_RESPONSE"
  | "EXTENDED_AGENT_CARD_NOT_CONFIGURED"
  | "EXTENSION_SUPPORT_REQUIRED"
  | "VERSION_NOT_SUPPORTED";

const ERROR_REASON_BY_CODE: Readonly<Partial<Record<A2aJsonRpcErrorCode, A2aErrorReason>>> = {
  [A2A_JSON_RPC_ERROR_CODES.TASK_NOT_FOUND]: "TASK_NOT_FOUND",
  [A2A_JSON_RPC_ERROR_CODES.TASK_NOT_CANCELABLE]: "TASK_NOT_CANCELABLE",
  [A2A_JSON_RPC_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED]: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  [A2A_JSON_RPC_ERROR_CODES.UNSUPPORTED_OPERATION]: "UNSUPPORTED_OPERATION",
  [A2A_JSON_RPC_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED]: "CONTENT_TYPE_NOT_SUPPORTED",
  [A2A_JSON_RPC_ERROR_CODES.INVALID_AGENT_RESPONSE]: "INVALID_AGENT_RESPONSE",
  [A2A_JSON_RPC_ERROR_CODES.EXTENDED_CARD_NOT_CONFIGURED]: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  [A2A_JSON_RPC_ERROR_CODES.EXTENSION_SUPPORT_REQUIRED]: "EXTENSION_SUPPORT_REQUIRED",
  [A2A_JSON_RPC_ERROR_CODES.VERSION_NOT_SUPPORTED]: "VERSION_NOT_SUPPORTED",
};

export const A2A_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const A2A_ERROR_DOMAIN = "a2a-protocol.org";

export type A2aErrorInfo = {
  "@type": typeof A2A_ERROR_INFO_TYPE;
  reason: A2aErrorReason;
  domain: typeof A2A_ERROR_DOMAIN;
  metadata?: Record<string, string>;
};

function buildErrorInfo(code: number, metadata?: Record<string, string>): A2aErrorInfo[] {
  // SAFETY: callers pass only `A2A_JSON_RPC_ERROR_CODES` values; unknown keys resolve to undefined.
  const reason = ERROR_REASON_BY_CODE[code as A2aJsonRpcErrorCode];
  if (!reason) {
    // Reserved JSON-RPC codes have no A2A reason; the numeric code is the contract.
    return [];
  }
  return [
    {
      "@type": A2A_ERROR_INFO_TYPE,
      reason,
      domain: A2A_ERROR_DOMAIN,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  ];
}

/**
 * A protocol-level failure rendered as a JSON-RPC error object.
 *
 * `code` alone is enough for the wire; `reason`/`metadata` let peers distinguish
 * e.g. "task expired" from "task belongs to another peer" without string matching.
 */
export class A2aProtocolError extends Error {
  readonly code: number;
  readonly reason: A2aErrorReason | undefined;
  readonly metadata: Record<string, string> | undefined;

  constructor(code: number, message: string, options: { metadata?: Record<string, string> } = {}) {
    super(message);
    this.name = "A2aProtocolError";
    this.code = code;
    // SAFETY: `code` is constrained to A2A error codes by every constructor call site.
    this.reason = ERROR_REASON_BY_CODE[code as A2aJsonRpcErrorCode];
    this.metadata = options.metadata;
  }

  /** Wire form of `error.data`: an array of google.rpc details. */
  toErrorData(): A2aErrorInfo[] {
    return buildErrorInfo(this.code, this.metadata);
  }
}

export function taskNotFound(message = "Task not found", taskId?: string): A2aProtocolError {
  return new A2aProtocolError(
    A2A_JSON_RPC_ERROR_CODES.TASK_NOT_FOUND,
    message,
    taskId ? { metadata: { taskId } } : {},
  );
}

export function unsupportedOperation(message: string): A2aProtocolError {
  return new A2aProtocolError(A2A_JSON_RPC_ERROR_CODES.UNSUPPORTED_OPERATION, message);
}

export function pushNotificationsUnsupported(): A2aProtocolError {
  return new A2aProtocolError(
    A2A_JSON_RPC_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
    "Push notifications are not supported; enable channels.a2a.capabilities.pushNotifications",
  );
}

export function extendedCardNotConfigured(): A2aProtocolError {
  return new A2aProtocolError(
    A2A_JSON_RPC_ERROR_CODES.EXTENDED_CARD_NOT_CONFIGURED,
    "Extended agent card is not configured; enable channels.a2a.capabilities.extendedAgentCard",
  );
}

export function taskNotCancelable(message = "Task is not in a cancelable state"): A2aProtocolError {
  return new A2aProtocolError(A2A_JSON_RPC_ERROR_CODES.TASK_NOT_CANCELABLE, message);
}

export function invalidParams(message: string): A2aProtocolError {
  return new A2aProtocolError(A2A_JSON_RPC_ERROR_CODES.INVALID_PARAMS, message);
}

export function contentTypeNotSupported(
  message: string,
  metadata?: Record<string, string>,
): A2aProtocolError {
  return new A2aProtocolError(
    A2A_JSON_RPC_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED,
    message,
    metadata ? { metadata } : undefined,
  );
}

export function versionNotSupported(message: string): A2aProtocolError {
  return new A2aProtocolError(A2A_JSON_RPC_ERROR_CODES.VERSION_NOT_SUPPORTED, message);
}

export function methodNotFound(method: string): A2aProtocolError {
  return new A2aProtocolError(
    A2A_JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
    `Method not found: ${method}`,
  );
}

/**
 * §4.6 / §3.3.2: an extension declared `required: true` in the Agent Card that
 * the client did not activate in `A2A-Extensions`. The agent MUST refuse rather
 * than silently serve a degraded response, so the URIs travel in `metadata`
 * instead of only the message.
 */
export function extensionSupportRequired(uris: string[]): A2aProtocolError {
  const listed = uris.join(", ");
  return new A2aProtocolError(
    A2A_JSON_RPC_ERROR_CODES.EXTENSION_SUPPORT_REQUIRED,
    `This agent requires the following extensions: ${listed}`,
    { metadata: { extensions: listed } },
  );
}
