/** Configuration schema for the Verdict plugin. */

import { Type } from "@sinclair/typebox";

export const verdictConfigSchema = Type.Object({
  /** URL of the Verdict gateway (e.g., http://localhost:8080). */
  gatewayUrl: Type.String({ description: "Verdict gateway URL" }),

  /** Request timeout in milliseconds. Default: 5000. */
  timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in ms", default: 5000 })),

  /** If true, gateway returns ALLOW but records real decision in audit. */
  shadowMode: Type.Optional(
    Type.Boolean({ description: "Shadow mode — evaluate but don't enforce", default: false }),
  ),

  /** If true (default), allow tool calls when the gateway is unreachable. */
  failOpen: Type.Optional(
    Type.Boolean({ description: "Allow tool calls when gateway is unreachable", default: true }),
  ),

  /** Principal identity for policy context. Default: "operator". */
  principal: Type.Optional(Type.String({ description: "Principal identity", default: "operator" })),

  /** Agent role for policy evaluation. Default: "default". */
  agentRole: Type.Optional(Type.String({ description: "Agent role", default: "default" })),

  /** Whether the operator's identity has been verified. */
  identityVerified: Type.Optional(
    Type.Boolean({ description: "Identity verification status", default: false }),
  ),

  /** Domain-specific context fields passed to every policy evaluation (e.g., customer_tier, department). Policies reference these via input.context.extra.* */
  extra: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Extra context fields for policies",
    }),
  ),

  /** Tool names to skip policy evaluation for. */
  skipTools: Type.Optional(
    Type.Array(Type.String(), { description: "Tools to skip evaluation for" }),
  ),
});

export type VerdictPluginConfig = {
  gatewayUrl: string;
  timeoutMs?: number;
  shadowMode?: boolean;
  failOpen?: boolean;
  principal?: string;
  agentRole?: string;
  identityVerified?: boolean;
  extra?: Record<string, unknown>;
  skipTools?: string[];
};
