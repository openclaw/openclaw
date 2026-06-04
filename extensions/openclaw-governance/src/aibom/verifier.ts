// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Adapted from kelliott-cloud/Nexus-10.0-A under operator-granted re-license.
// Original: backend/governance/aibom_signer.py.

import { AibomSigner, type VerifyResult } from "./signer.js";
import { fromJson, type AIBOMRecord } from "./record.js";

export type StoredAibomEntry = {
  record: Record<string, unknown>;
  signature: string;
};

export function verifyStoredEntry(signer: AibomSigner, entry: StoredAibomEntry): VerifyResult {
  return signer.verify(entry.signature, entry.record);
}

export function rehydrateRecord(stored: Record<string, unknown>): AIBOMRecord {
  return fromJson(stored);
}
