import { Type, type Static } from "typebox";
import type { Calculation } from "./evidence.js";

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
  retrievedAt: string;
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
  providerCitations?: Array<{ url: string; title?: string; startByte?: number; endByte?: number }>;
  route: { model: string; runtime: "direct-provider" | "managed-service" };
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
    "Start, inspect, resume or cancel evidence-backed research. Portable uses ordinary API completions and configured web tools; Google uses an explicitly activated managed research service. Reuse the same idempotency key for a retried start. Results include honest gaps and route-specific evidence.",
  parameters: researchToolSchema,
};
