/**
 * OCI Generative AI model catalog.
 *
 * The catalog is shared between the two transport surfaces this plugin
 * exposes:
 *
 *   - V1 (OpenAI-compatible) — `/openai/v1/chat/completions`. The
 *     default for openclaw's openai-completions transport. Almost
 *     every model OCI offers is reachable here, including Cohere
 *     R-series chat in their OpenAI-shaped form.
 *   - Regular (native OCI) — `/20231130/actions/chat`. Required when
 *     callers need OCI-native features such as Cohere citations,
 *     search-grounded RAG, or the native streaming envelope. Exposed
 *     through `OciNativeClient` and `createOciSignedFetch` for
 *     power-user code paths; the catalog itself stays on the V1 shape
 *     so the standard openai-completions transport keeps working
 *     unchanged.
 *
 * Source:
 * `inference.generativeai.<region>.oci.oraclecloud.com/openai/v1/models`
 * lists what each region currently serves; the table below is the subset
 * available across the global OCI GenAI footprint as of Q2 2026.
 *
 * Pricing reflects OCI's per-token rates published at
 * https://www.oracle.com/cloud/generative-ai/pricing/  — values in
 * USD per 1M tokens.  Numbers move; treat as documentation, not a
 * billing contract.
 */

import type { OciRegion } from "./regions.js";

export type OciGenAIModelId =
  | "meta.llama-3.3-70b-instruct"
  | "meta.llama-3.1-405b-instruct"
  | "xai.grok-4"
  | "xai.grok-3"
  | "mistral.codestral-2506"
  | "google.gemini-2.5-pro"
  | "google.gemini-2.5-flash"
  | "openai.gpt-oss-120b"
  | "cohere.command-r-08-2024"
  | "cohere.command-r-plus-08-2024"
  | "cohere.command-a-03-2025";

export type OciGenAIModelEntry = {
  readonly id: OciGenAIModelId;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly toolUse: boolean;
  readonly vision: boolean;
  readonly cost: {
    readonly input: number; // USD / 1M input tokens
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
};

export const OCI_GENAI_MODELS: readonly OciGenAIModelEntry[] = [
  {
    id: "meta.llama-3.3-70b-instruct",
    name: "Meta Llama 3.3 70B Instruct",
    contextWindow: 128_000,
    maxTokens: 4_096,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 0.6, output: 0.6 },
  },
  {
    id: "meta.llama-3.1-405b-instruct",
    name: "Meta Llama 3.1 405B Instruct",
    contextWindow: 128_000,
    maxTokens: 4_096,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 5.32, output: 16.0 },
  },
  {
    id: "xai.grok-4",
    name: "xAI Grok 4",
    contextWindow: 256_000,
    maxTokens: 8_192,
    reasoning: true,
    toolUse: true,
    vision: true,
    cost: { input: 5.0, output: 15.0 },
  },
  {
    id: "xai.grok-3",
    name: "xAI Grok 3",
    contextWindow: 131_072,
    maxTokens: 8_192,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 3.0, output: 15.0 },
  },
  {
    id: "mistral.codestral-2506",
    name: "Mistral Codestral 25.06",
    contextWindow: 256_000,
    maxTokens: 8_192,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 0.3, output: 0.9 },
  },
  {
    id: "google.gemini-2.5-pro",
    name: "Google Gemini 2.5 Pro (via OCI)",
    contextWindow: 2_000_000,
    maxTokens: 8_192,
    reasoning: true,
    toolUse: true,
    vision: true,
    cost: { input: 1.25, output: 10.0 },
  },
  {
    id: "google.gemini-2.5-flash",
    name: "Google Gemini 2.5 Flash (via OCI)",
    contextWindow: 1_000_000,
    maxTokens: 8_192,
    reasoning: false,
    toolUse: true,
    vision: true,
    cost: { input: 0.3, output: 2.5 },
  },
  {
    id: "openai.gpt-oss-120b",
    name: "OpenAI GPT-OSS 120B",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 0.5, output: 1.5 },
  },
  {
    id: "cohere.command-r-08-2024",
    name: "Cohere Command R (08-2024)",
    contextWindow: 128_000,
    maxTokens: 4_096,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 0.15, output: 0.6 },
  },
  {
    id: "cohere.command-r-plus-08-2024",
    name: "Cohere Command R+ (08-2024)",
    contextWindow: 128_000,
    maxTokens: 4_096,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 2.5, output: 10.0 },
  },
  {
    id: "cohere.command-a-03-2025",
    name: "Cohere Command A (03-2025)",
    contextWindow: 256_000,
    maxTokens: 8_192,
    reasoning: false,
    toolUse: true,
    vision: false,
    cost: { input: 2.5, output: 10.0 },
  },
] as const;

export function findOciGenAIModel(id: string): OciGenAIModelEntry | undefined {
  return OCI_GENAI_MODELS.find((entry) => entry.id === id);
}

export function buildOciGenAIBaseUrl(region: OciRegion): string {
  return `https://inference.generativeai.${region}.oci.oraclecloud.com/openai/v1`;
}
