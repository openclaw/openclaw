import {
  type FailoverClassificationCorpusRow,
  billingSource,
  messageRows,
  failoverSignalRows,
  reason,
  retrySource,
} from "./failover-classification.corpus.test-support.js";
export const structuredMiscCases = [
  {
    id: "service-model-mismatch",
    source: retrySource,
    signal: {
      provider: "tencent-tokenhub",
      message:
        '400 {"error":{"code":"401006","type":"invalid_request_error","message":"The service ID does not exist, or the model does not match the service. Please confirm the service ID in the Online Inference Service list in the console."}}',
    },
    expected: reason("format"),
  },
  {
    id: "billing-image-dimension",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
    },
    expected: reason("format"),
  },
  ...failoverSignalRows(billingSource, null, [
    ["billing-image-size", { message: "image exceeds 5 MB maximum" }],
  ]),
  ...messageRows(retrySource, null, [{ id: "retry-delay", message: "retry delay 1000ms" }]),
] satisfies readonly FailoverClassificationCorpusRow[];
