import {
  type FailoverClassificationCorpusRow,
  billingSource,
  contextOverflow,
  messageRows,
  failoverSignalRows,
  patternsSource,
} from "./failover-classification.corpus.test-support.js";
export const overflowCases = [
  ...failoverSignalRows(billingSource, contextOverflow, [
    [
      "billing-context-dashscope-range",
      {
        message:
          "400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]",
      },
    ],
    [
      "billing-context-siliconflow-max-seq-len",
      {
        message:
          '400 {"code":20015,"message":"length of prompt_tokens (51353) must be less than max_seq_len (32768).","data":null}',
      },
    ],
    [
      "billing-context-vllm-decoder-prompt",
      {
        message:
          "400 The decoder prompt (length 40000) is longer than the maximum model length of 32768. Make sure that `max_model_len` is no smaller than the number of text tokens.",
      },
    ],
    [
      "billing-context-vllm-engine-prompt",
      {
        message:
          "400 The engine prompt length 40000 exceeds the max_model_len 32768. Please reduce prompt.",
      },
    ],
  ]),
  ...failoverSignalRows(patternsSource, contextOverflow, [
    ["patterns-context-llamacpp-exceeded-500", { message: "500 Context size has been exceeded." }],
    [
      "patterns-context-tgi-total",
      {
        status: 422,
        message:
          "422 Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 28897 `inputs` tokens and 3872 `max_new_tokens`",
      },
    ],
    [
      "patterns-context-tgi-input",
      {
        status: 422,
        message:
          "422 Input validation error: `inputs` must have less than 32768 tokens. Given: 40000",
      },
    ],
  ]),
  ...messageRows(patternsSource, contextOverflow, [
    {
      id: "patterns-context-lmstudio-loaded-length-400",
      status: 400,
      message:
        '400 " Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input. Error Data: n/a, Additional Data: n/a"',
    },
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
