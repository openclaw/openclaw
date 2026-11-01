import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Only an explicit parameter rejection permits resending at a slower tier. */
export function isResponsesServiceTierRejection(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const detail = isRecord(error.error) ? error.error : error;
  const status = error.status ?? detail.status;
  if (status !== undefined && status !== 400 && status !== 422) {
    return false;
  }
  const invalidRequest =
    detail.type === "invalid_request_error" ||
    detail.code === "invalid_request_error" ||
    detail.code === "unsupported_parameter" ||
    detail.code === "unsupported_value" ||
    detail.code === "invalid_value" ||
    (detail.code === "invalid_prompt" && detail.message === "Invalid service_tier argument") ||
    (detail.code === null &&
      detail.param === "service_tier" &&
      (detail.type === "error" || detail.type === undefined)) ||
    status === 400 ||
    status === 422;
  return (
    invalidRequest &&
    (detail.param === "service_tier" || detail.message === "Invalid service_tier argument")
  );
}

export function nextResponsesServiceTier(
  requestedTier: unknown,
  error: unknown,
): "priority" | "default" | undefined {
  if (!isResponsesServiceTierRejection(error)) {
    return undefined;
  }
  return requestedTier === "ultrafast"
    ? "priority"
    : requestedTier === "priority"
      ? "default"
      : undefined;
}
