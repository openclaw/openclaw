import { z } from "zod";

export const ventureMetricSchema = z.object({
  key: z.string().min(1),
  value: z.number(),
  unit: z.string().optional(),
});

export const ventureArtifactSchema = z.object({
  kind: z.string().min(1),
  uri: z.string().min(1),
  label: z.string().optional(),
});

export const ventureEventSchema = z.object({
  ts: z.string().datetime(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).optional(),
});

export const ventureResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string().min(1),
  metrics: z.array(ventureMetricSchema).default([]),
  artifacts: z.array(ventureArtifactSchema).default([]),
  events: z.array(ventureEventSchema).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

export type VentureMetric = z.infer<typeof ventureMetricSchema>;
export type VentureArtifact = z.infer<typeof ventureArtifactSchema>;
export type VentureEvent = z.infer<typeof ventureEventSchema>;
export type VentureResult = z.infer<typeof ventureResultSchema>;

export function parseVentureResult(input: unknown): VentureResult {
  return ventureResultSchema.parse(input);
}

