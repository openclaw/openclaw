// Vendor-private wire contract. This is not an OpenClaw model or inference API.
type SageReasoning = "auto" | "off" | "on";
type SageGrounding = {
  trigger?: "never" | "low_confidence" | "always";
  confidence_floor?: number;
  max_results?: number;
  max_context_tokens?: number;
  return_sources?: boolean;
};
type SageText = string | { kind: "text"; value: string };
type SageList = { kind: "list"; value: { id: string; content: SageText | SageList }[] };
export type SageContent =
  | SageText
  | SageList
  | { kind: "image"; media: string; text?: string | null };
type QuestionBase = { id: string; instructions: string };
export type SageQuestion =
  | (QuestionBase & { kind: "yesno" })
  | (QuestionBase & { kind: "choice"; options: { option: string; description?: string | null }[] })
  | (QuestionBase & { kind: "scale"; levels: { level: number; description?: string | null }[] })
  | (QuestionBase & { kind: "sort" })
  | {
      id: string;
      kind: "tags";
      instructions?: string | null;
      tags: { id: string; name?: string | null; threshold?: number | null }[];
    };
type SageBatchQuestion = SageQuestion & { grounding?: SageGrounding | null };
export type SageRequest = {
  content: SageContent;
  question: SageQuestion;
  reasoning?: SageReasoning;
  grounding?: SageGrounding | null;
};
export type SageBatchRequest = {
  requests: { content: SageContent; questions: SageBatchQuestion[] }[];
  reasoning?: SageReasoning;
};
type SageJson = null | boolean | number | string | SageJson[] | { [key: string]: SageJson };
type SageMetadata = { [key: string]: SageJson };
type SageUsage = SageMetadata & {
  input_tokens: number;
  output_tokens: number;
  image_count?: number;
  image_tokens?: number;
};
type SageMeta = SageMetadata & {
  model?: string;
  latency_ms?: number | null;
  question_count?: number | null;
  compute_mode?: string | null;
  usage?: SageUsage | null;
  reasoning?:
    | (SageMetadata & {
        ran: boolean;
        finished?: boolean | null;
        tokens?: number | null;
        limited?: "cap" | "timeout" | "budget" | null;
        forced?: boolean;
      })
    | null;
};
type ResponseBase = { id: string; meta: SageMeta; grounding_meta?: SageMetadata | null };
export type SageResponse = ResponseBase &
  (
    | { kind: "yesno"; result: { answer: "yes" | "no" | null; probability: number } }
    | {
        kind: "choice";
        result: {
          chosen: string | null;
          probability: number | null;
          probabilities: { option: string; probability: number }[];
        };
      }
    | {
        kind: "scale";
        result: {
          expectation: number;
          confidence: number;
          probabilities: { level: number; probability: number }[];
        };
      }
    | { kind: "sort"; result: { sorted: string[]; confidence?: number | null } }
    | {
        kind: "tags";
        result: { tags: { id: string; probability: number; applies: boolean | null }[] };
      }
  );
export type SageBatchResponse = {
  results: {
    answers: (
      | { ok: true; result: SageResponse; error?: null }
      | { ok: false; error: string; result?: null }
    )[];
  }[];
  meta: SageMeta & { request_count: number; question_count: number };
};
