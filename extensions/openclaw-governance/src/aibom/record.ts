// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Adapted from kelliott-cloud/Nexus-10.0-A under operator-granted re-license.
// Original: backend/governance/aibom.py.

import { createHash } from "node:crypto";

// Free-form string so callers can record provider-specific modalities; common
// values are "text" | "image" | "video" | "audio" | "embedding".
export type AIBOMModality = string;

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
  const modality = input.modality ? input.modality.trim().toLowerCase() || "text" : "text";
  return {
    modelId: input.modelId,
    provider: input.provider,
    promptHash: input.promptHash ?? hashText(input.prompt ?? ""),
    completionHash: input.completionHash ?? hashText(input.completion ?? ""),
    sessionKey: input.sessionKey,
    runId: input.runId,
    toolsUsed: Array.from(input.toolsUsed ?? []),
    trainingDataTags: Array.from(input.trainingDataTags ?? []),
    generatedAt: input.generatedAt ?? utcIsoNow(),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.skillId ? { skillId: input.skillId } : {}),
    modality,
    extra: { ...input.extra },
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
  if (record.channelId !== undefined) {
    payload.channelId = record.channelId;
  }
  if (record.skillId !== undefined) {
    payload.skillId = record.skillId;
  }
  JSON.stringify(payload);
  return payload;
}

function readStringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function fromJson(payload: Record<string, unknown>): AIBOMRecord {
  const channelId = readStringField(payload.channelId);
  const skillId = readStringField(payload.skillId);
  return {
    modelId: readStringField(payload.modelId),
    provider: readStringField(payload.provider),
    promptHash: readStringField(payload.promptHash),
    completionHash: readStringField(payload.completionHash),
    sessionKey: readStringField(payload.sessionKey),
    runId: readStringField(payload.runId),
    toolsUsed: Array.isArray(payload.toolsUsed)
      ? payload.toolsUsed.filter((entry): entry is string => typeof entry === "string")
      : [],
    trainingDataTags: Array.isArray(payload.trainingDataTags)
      ? payload.trainingDataTags.filter((entry): entry is string => typeof entry === "string")
      : [],
    generatedAt: readStringField(payload.generatedAt),
    ...(channelId ? { channelId } : {}),
    ...(skillId ? { skillId } : {}),
    modality: readStringField(payload.modality, "text"),
    extra: (payload.extra as Record<string, unknown>) ?? {},
  };
}
