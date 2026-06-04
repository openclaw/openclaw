// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Adapted from kelliott-cloud/Nexus-10.0-A under operator-granted re-license.
// Original: backend/governance/aibom.py + record_aibom_for_response in
// backend/governance/model_gateway.py.

import { randomUUID } from "node:crypto";
import { buildRecord, toJson, type AIBOMRecord, type BuildRecordInput } from "./record.js";
import { AibomSigner } from "./signer.js";
import type { AibomRow, GovernanceStore } from "../store/sqlite.js";

export type RecordInferenceParams = Omit<BuildRecordInput, "generatedAt"> & {
  generatedAt?: string;
};

export type RecordedAibom = {
  id: string;
  record: AIBOMRecord;
  signature: string;
};

export class AibomRecorder {
  constructor(
    private readonly signer: AibomSigner,
    private readonly store: GovernanceStore,
  ) {}

  record(params: RecordInferenceParams): RecordedAibom {
    const record = buildRecord(params);
    const recordJson = toJson(record);
    const signature = this.signer.sign(recordJson);
    const id = randomUUID();
    const now = Date.now();
    const row: AibomRow = {
      id,
      runId: record.runId,
      sessionKey: record.sessionKey,
      provider: record.provider,
      modelId: record.modelId,
      channelId: record.channelId ?? null,
      skillId: record.skillId ?? null,
      recordJson: JSON.stringify(recordJson),
      signature,
      generatedAt: record.generatedAt,
      createdAtMs: now,
    };
    this.store.insertAibom(row);
    return { id, record, signature };
  }

  signer_(): AibomSigner {
    return this.signer;
  }
}
