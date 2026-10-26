import {
  type FailoverClassificationCorpusRow,
  billingSource,
  httpSource,
  failoverSignalRows,
  patternsSource,
  reason,
  structuredSource,
} from "./failover-classification.corpus.test-support.js";
export const authFormatCases = [
  {
    id: "patterns-html-407",
    source: patternsSource,
    signal: {
      status: 407,
      message:
        "<!doctype html><html><head><title>407 Proxy Authentication Required</title></head><body><h1>Proxy Authentication Required</h1></body></html>",
    },
    expected: reason("auth"),
  },
  ...failoverSignalRows(structuredSource, reason("format"), [
    [
      "structured-tgi-output-only",
      {
        status: 422,
        message: "Input validation error: `max_new_tokens` must be <= 4096. Given: 8192",
      },
    ],
  ]),
  {
    id: "bedrock-deprecated-temperature",
    source: "extensions/amazon-bedrock/index.test.ts",
    signal: {
      provider: "amazon-bedrock",
      message:
        'ValidationException: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
    },
    expected: null,
  },
  {
    id: "billing-context-reasoning-required",
    source: billingSource,
    signal: { message: "400 Reasoning is mandatory for this endpoint and cannot be disabled." },
    expected: reason("format"),
  },
  {
    id: "http-legacy-bad-request-normalized",
    source: httpSource,
    signal: {
      status: 400,
      code: "invalid_request",
      message:
        "Legacy provider error (HTTP 400): Bad request [code=invalid_request] [request_id=req_legacy]",
    },
    expected: reason("format"),
  },
] satisfies readonly FailoverClassificationCorpusRow[];
