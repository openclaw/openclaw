// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Adapted from kelliott-cloud/Nexus-10.0-A under operator-granted re-license.
// Original: backend/governance/aibom.py.

import { createHash } from "node:crypto";

export type AIBOMModality = "text" | "image" | "video" | "audio" | "embedding" | string;

export type AIBOMRecord = {
  modelId: string;
  provider: string;
  promptHash: string;
  completionHash: string;
  sessionKey: string;
  runId: string;
  toolsUsed: string[];
  trainingDataTags: string[];
  generatedAt: string;
  channelId?: string;
  skillId?: string;
  modality: AIBOMModality;
  extra: Record<string, unknown>;
};

export type BuildRecordInput = {
  modelId: string;
  provider: string;
  sessionKey: string;
  runId: string;
  prompt?: string | null;
  completion?: string | null;
  promptHash?: string | null;
  completionHash?: string | null;
  toolsUsed?: Iterable<string>;
  trainingDataTags?: Iterable<string>;
  generatedAt?: string;
  channelId?: string;
  skillId?: string;
  modality?: AIBOMModality | null;
  extra?: Record<string, unknown>;
};

function utcIsoNow(): string {
  return new Date().toISOString();
}

export function hashText(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = typeof value === "string" ? value : String(value);
  return createHash("sha256").update(str, "utf8").digest("hex");
}

export function buildRecord(input: BuildRecordInput): AIBOMRecord {
  const modality = input.modality ? String(input.modality).trim().toLowerCase() || "text" : "text";
  return {
    modelId: String(input.modelId),
    provider: String(input.provider),
    promptHash: input.promptHash ?? hashText(input.prompt ?? ""),
    completionHash: input.completionHash ?? hashText(input.completion ?? ""),
    sessionKey: String(input.sessionKey),
    runId: String(input.runId),
    toolsUsed: Array.from(input.toolsUsed ?? []),
    trainingDataTags: Array.from(input.trainingDataTags ?? []),
    generatedAt: input.generatedAt ?? utcIsoNow(),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.skillId ? { skillId: input.skillId } : {}),
    modality,
    extra: { ...(input.extra ?? {}) },
  };
}

export function toJson(record: AIBOMRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    modelId: record.modelId,
    provider: record.provider,
    promptHash: record.promptHash,
    completionHash: record.completionHash,
    sessionKey: record.sessionKey,
    runId: record.runId,
    toolsUsed: [...record.toolsUsed],
    trainingDataTags: [...record.trainingDataTags],
    generatedAt: record.generatedAt,
    modality: record.modality,
    extra: { ...record.extra },
  };
  if (record.channelId !== undefined) payload.channelId = record.channelId;
  if (record.skillId !== undefined) payload.skillId = record.skillId;
  JSON.stringify(payload);
  return payload;
}

export function fromJson(payload: Record<string, unknown>): AIBOMRecord {
  return {
    modelId: String(payload.modelId ?? ""),
    provider: String(payload.provider ?? ""),
    promptHash: String(payload.promptHash ?? ""),
    completionHash: String(payload.completionHash ?? ""),
    sessionKey: String(payload.sessionKey ?? ""),
    runId: String(payload.runId ?? ""),
    toolsUsed: Array.isArray(payload.toolsUsed) ? (payload.toolsUsed as string[]).map(String) : [],
    trainingDataTags: Array.isArray(payload.trainingDataTags)
      ? (payload.trainingDataTags as string[]).map(String)
      : [],
    generatedAt: String(payload.generatedAt ?? ""),
    ...(payload.channelId !== undefined && payload.channelId !== null
      ? { channelId: String(payload.channelId) }
      : {}),
    ...(payload.skillId !== undefined && payload.skillId !== null
      ? { skillId: String(payload.skillId) }
      : {}),
    modality: String(payload.modality ?? "text"),
    extra: (payload.extra as Record<string, unknown>) ?? {},
  };
}
