import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { classifyTransientNetworkErrorCode } from "openclaw/plugin-sdk/retry-runtime";

export function isTransientSlackApiError(error: unknown): boolean {
  if (error instanceof WebAPIRateLimitedError) {
    return true;
  }
  if (error instanceof WebAPIHTTPError) {
    return (
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode < 600)
    );
  }
  // Slack reports these platform codes for transient service failures.
  if (error instanceof WebAPIPlatformError) {
    return error.data.error === "internal_error" || error.data.error === "service_unavailable";
  }
  // Web API 8.2.0 unwraps a malformed 429 Retry-After into this plain Error.
  if (
    error instanceof Error &&
    error.name === "Error" &&
    /^Retry header did not contain a valid timeout \(url: https?:\/\/\S+, retry-after header: [^\r\n]*\)$/.test(
      error.message,
    )
  ) {
    return true;
  }
  if (!(error instanceof WebAPIRequestError)) {
    return false;
  }
  // Slack Web API 8.0.0 wraps exhausted 429 retries as this uncoded request error.
  if (/^A rate limit was exceeded \(url: .+, retry-after: \d+\)$/.test(error.original.message)) {
    return true;
  }
  return collectErrorGraphCandidates(error.original, (current) => [
    current.cause,
    current.error,
    current.original,
  ]).some(
    (candidate) =>
      classifyTransientNetworkErrorCode(extractErrorCode(candidate)) ||
      readErrorName(candidate) === "TimeoutError",
  );
}
