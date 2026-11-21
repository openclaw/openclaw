import { Type, type Static } from "typebox";

type CalculationInput = {
  value: number;
  unit: string;
  asOf: string;
  sourceId: string;
  quote: string;
};

type Calculation = {
  operation: "sum" | "difference" | "ratio" | "percent-change";
  inputs: [CalculationInput, CalculationInput];
  value: number;
  unit: string;
  asOf: string;
};

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const limit = (maximum: number) => Type.Optional(Type.Integer({ minimum: 1, maximum }));
export const researchRequestSchema = Type.Object(
  {
    question: text(8_000),
    engine: Type.Optional(Type.Union([Type.Literal("portable"), Type.Literal("google")])),
    model: Type.Optional(text(256)),
    requiredAuthMode: Type.Optional(Type.Literal("oauth")),
    output: Type.Optional(text(2_000)),
    asOf: Type.Optional(text(64)),
    sources: Type.Optional(
      Type.Object(
        {
          web: Type.Optional(Type.Boolean()),
          urls: Type.Optional(Type.Array(text(2_048), { maxItems: 20 })),
          allowDomains: Type.Optional(Type.Array(text(253), { maxItems: 20 })),
          denyDomains: Type.Optional(Type.Array(text(253), { maxItems: 20 })),
          documents: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  title: text(256),
                  text: text(20_000),
                },
                { additionalProperties: false },
              ),
              { maxItems: 10 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    budget: Type.Optional(
      Type.Object(
        {
          modelCalls: limit(30),
          searches: limit(20),
          fetches: limit(40),
          durationMs: limit(900_000),
          parallelism: limit(4),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ResearchRequest = Static<typeof researchRequestSchema>;
export type ResearchSource = {
  id: string;
  url?: string;
  requestedUrl?: string;
  title: string;
  text: string;
  retrievedAt?: string;
  fingerprint: string;
  extraction: "web-fetch-text-v1" | "supplied-text-v1";
};
export type ResearchFinding = {
  statement: string;
  evidence: Array<{ sourceId: string; quote: string }>;
  calculation?: Calculation;
  support: "quote-matched" | "model-supported";
};
export type ResearchResult = {
  version: 1;
  engine: "portable" | "managed";
  status: "completed" | "partial" | "cancelled";
  report: string;
  findings: ResearchFinding[];
  sources: ResearchSource[];
  gaps: string[];
  limitations: string[];
  usage: {
    modelCalls: number;
    searches: number;
    fetches: number;
    reportedTokens: number;
    tokensComplete: boolean;
  };
  /** Half-open UTF-8 byte ranges emitted with the portable report. */
  reportCitations?: Array<{ sourceId: string; startByte: number; endByte: number }>;
  providerCitations?: Array<{ url: string; title?: string; startByte?: number; endByte?: number }>;
  route: {
    model: string;
    runtime: "direct-provider" | "isolated-agent-runtime" | "managed-service" | "unobserved";
    owner?: { kind: "provider" | "cli" | "harness"; id: string };
  };
};

export const researchToolSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("start"), idempotencyKey: text(128), request: researchRequestSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("result"),
        Type.Literal("resume"),
        Type.Literal("cancel"),
      ]),
      jobId: text(64),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("capabilities") }, { additionalProperties: false }),
]);

export const researchToolDefinition = {
  name: "deep_research",
  label: "Deep Research",
  description:
    "Use for explicit conversational requests to perform deep research or produce a substantial source-backed report, and follow-ups on its retained jobs. Do not use for quick general answers, explanations of Deep Research, quoted/code mentions, or a request not to research. Use the current chat’s sources and budget; supplied documents default to no web. Portable uses the configured model/runtime and credentials (OAuth-only is direct); Google must be configured explicitly. Reuse the start key after uncertainty. Use the returned jobId for status, result, resume or cancellation; report only its actual state, evidence and gaps, never started without a receipt.",
  parameters: researchToolSchema,
};
