// Qa Lab plugin module defines shared QA transport contracts.
import { z } from "zod";

export const QA_TRANSPORT_CAPABILITY_MANIFEST_VERSION = 1 as const;

export const QA_TRANSPORT_CAPABILITIES = [
  "approvals.callbacks",
  "approvals.presentation",
  "commands.native",
  "gateway.restart",
  "identity.bot",
  "matrix.device-management",
  "matrix.e2ee",
  "matrix.key-backup",
  "matrix.qr-verification",
  "matrix.sas-verification",
  "membership",
  "mentions.structured",
  "messages.attachments",
  "messages.chunk-lifecycle",
  "messages.deletes",
  "messages.edits",
  "messages.polls",
  "messages.preview-lifecycle",
  "messages.structured",
  "messages.text",
  "provider.restart",
  "relations.reactions",
  "relations.redactions",
  "relations.replies",
  "relations.threads",
  "sync.replay",
] as const;

export const QA_TRANSPORT_OPERATIONS = [
  "action.delete",
  "action.edit",
  "action.react",
  "action.thread-create",
  "message.send-inbound",
  "message.send-native-command",
  "message.wait-for-none",
  "message.wait-for-outbound",
  "message.wait-for-outbound-sequence",
  "state.read",
  "state.reset",
] as const;

export type QaTransportCapability = (typeof QA_TRANSPORT_CAPABILITIES)[number];
export type QaTransportOperation = (typeof QA_TRANSPORT_OPERATIONS)[number];

export const qaTransportCapabilitySchema = z.enum(QA_TRANSPORT_CAPABILITIES);
export const qaTransportOperationSchema = z.enum(QA_TRANSPORT_OPERATIONS);

export const qaTransportCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(QA_TRANSPORT_CAPABILITY_MANIFEST_VERSION),
    transport: z
      .object({
        adapterId: z.string().trim().min(1),
        channelId: z.string().trim().min(1),
        driver: z.string().trim().min(1),
      })
      .strict(),
    capabilities: z.array(qaTransportCapabilitySchema),
    operations: z.array(qaTransportOperationSchema),
  })
  .strict();

export type QaTransportCapabilityManifest = z.infer<typeof qaTransportCapabilityManifestSchema>;

export function createQaTransportCapabilityManifest(params: {
  adapterId: string;
  channelId: string;
  driver: string;
  capabilities: readonly QaTransportCapability[];
  operations: readonly QaTransportOperation[];
}): QaTransportCapabilityManifest {
  return qaTransportCapabilityManifestSchema.parse({
    schemaVersion: QA_TRANSPORT_CAPABILITY_MANIFEST_VERSION,
    transport: {
      adapterId: params.adapterId,
      channelId: params.channelId,
      driver: params.driver,
    },
    capabilities: [...new Set(params.capabilities)].toSorted(),
    operations: [...new Set(params.operations)].toSorted(),
  });
}

const qaTransportMissingCapabilitiesErrorSchema = z
  .object({
    code: z.literal("missing_capabilities"),
    availableCapabilities: z.array(qaTransportCapabilitySchema),
    missingCapabilities: z.array(qaTransportCapabilitySchema).min(1),
    requestedCapabilities: z.array(qaTransportCapabilitySchema).min(1),
    transportId: z.string().trim().min(1),
  })
  .strict();

const qaTransportStartupFailureErrorSchema = z
  .object({
    code: z.literal("startup_failure"),
    factoryId: z.string().trim().min(1),
    message: z.string().trim().min(1),
    transportId: z.string().trim().min(1),
  })
  .strict();

const qaTransportCredentialBlockedErrorSchema = z
  .object({
    code: z.literal("credential_blocked"),
    channelId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    retryable: z.boolean(),
  })
  .strict();

const qaTransportUnsupportedOperationErrorSchema = z
  .object({
    code: z.literal("unsupported_operation"),
    operation: qaTransportOperationSchema,
    supportedOperations: z.array(qaTransportOperationSchema),
    transportId: z.string().trim().min(1),
  })
  .strict();

export const qaTransportNormalizedErrorSchema = z.discriminatedUnion("code", [
  qaTransportMissingCapabilitiesErrorSchema,
  qaTransportStartupFailureErrorSchema,
  qaTransportCredentialBlockedErrorSchema,
  qaTransportUnsupportedOperationErrorSchema,
]);

export type QaTransportNormalizedError = z.infer<typeof qaTransportNormalizedErrorSchema>;

export class QaTransportContractError extends Error {
  readonly normalized: QaTransportNormalizedError;

  constructor(normalized: QaTransportNormalizedError, options?: ErrorOptions) {
    super(formatQaTransportNormalizedError(normalized), options);
    this.name = "QaTransportContractError";
    this.normalized = qaTransportNormalizedErrorSchema.parse(normalized);
  }
}

function formatQaTransportNormalizedError(error: QaTransportNormalizedError): string {
  switch (error.code) {
    case "missing_capabilities":
      return `${error.transportId} is missing required capabilities: ${error.missingCapabilities.join(", ")}`;
    case "startup_failure":
      return `${error.transportId} failed to start through ${error.factoryId}: ${error.message}`;
    case "credential_blocked":
      return `${error.channelId} credentials blocked transport startup: ${error.reason}`;
    case "unsupported_operation":
      return `${error.transportId} does not support operation ${error.operation}`;
  }
  throw new Error("unknown QA transport error");
}

export function createQaTransportMissingCapabilitiesError(params: {
  manifest: QaTransportCapabilityManifest;
  requestedCapabilities: readonly QaTransportCapability[];
}): QaTransportContractError | null {
  const requestedCapabilities = [...new Set(params.requestedCapabilities)].toSorted();
  const availableCapabilities = [...params.manifest.capabilities].toSorted();
  const availableCapabilitySet = new Set(availableCapabilities);
  const missingCapabilities = requestedCapabilities.filter(
    (capability) => !availableCapabilitySet.has(capability),
  );
  if (missingCapabilities.length === 0) {
    return null;
  }
  return new QaTransportContractError({
    code: "missing_capabilities",
    transportId: params.manifest.transport.adapterId,
    requestedCapabilities,
    availableCapabilities,
    missingCapabilities,
  });
}

export function createQaTransportStartupFailureError(params: {
  cause: unknown;
  factoryId: string;
  transportId: string;
}): QaTransportContractError {
  const causeMessage = params.cause instanceof Error ? params.cause.message : String(params.cause);
  const message = causeMessage.trim() || "unknown transport startup failure";
  return new QaTransportContractError(
    {
      code: "startup_failure",
      factoryId: params.factoryId,
      message,
      transportId: params.transportId,
    },
    { cause: params.cause },
  );
}

export function createQaTransportCredentialBlockedError(params: {
  channelId: string;
  reason: string;
  retryable: boolean;
}): QaTransportContractError {
  return new QaTransportContractError({
    code: "credential_blocked",
    channelId: params.channelId,
    reason: params.reason,
    retryable: params.retryable,
  });
}

export function createQaTransportUnsupportedOperationError(params: {
  operation: QaTransportOperation;
  supportedOperations: readonly QaTransportOperation[];
  transportId: string;
}): QaTransportContractError {
  return new QaTransportContractError({
    code: "unsupported_operation",
    operation: params.operation,
    supportedOperations: [...new Set(params.supportedOperations)].toSorted(),
    transportId: params.transportId,
  });
}
