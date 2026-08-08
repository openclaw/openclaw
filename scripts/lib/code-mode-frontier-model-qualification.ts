import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const OPENAI_MANIFEST_PATH = "extensions/openai/openclaw.plugin.json";
const OPENAI_MANIFEST_URL = new URL(
  "../../extensions/openai/openclaw.plugin.json",
  import.meta.url,
);

export const FRONTIER_QUALIFICATION_CANDIDATE_MODEL_REFS = new Set([
  "openai/gpt-5.4",
  "openai/gpt-5.6",
]);

export type FrontierCodeModeCapabilityReceipt = {
  api: "openai-responses";
  codeMode: "preferred";
  endpoint: "https://api.openai.com/v1";
  manifestPath: typeof OPENAI_MANIFEST_PATH;
  manifestSha256: string;
  modelRef: string;
  modelRowSha256: string;
  source: "bundled_openai_manifest";
  status: "available";
  version: 1;
};

export type FrontierModelQualificationResult =
  | { ok: true; receipt: FrontierCodeModeCapabilityReceipt }
  | {
      ok: false;
      reason:
        | "candidate_out_of_scope"
        | "code_mode_unsupported"
        | "manifest_invalid"
        | "model_missing"
        | "model_unavailable"
        | "route_unsupported";
    };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function isFrontierQualificationCandidateModel(modelRef: string): boolean {
  return FRONTIER_QUALIFICATION_CANDIDATE_MODEL_REFS.has(modelRef);
}

export function isFrontierCodeModeCapabilityReceipt(
  value: unknown,
  modelRef?: string,
): value is FrontierCodeModeCapabilityReceipt {
  return (
    isRecord(value) &&
    Object.keys(value).toSorted().join(",") ===
      [
        "api",
        "codeMode",
        "endpoint",
        "manifestPath",
        "manifestSha256",
        "modelRef",
        "modelRowSha256",
        "source",
        "status",
        "version",
      ]
        .toSorted()
        .join(",") &&
    value.version === 1 &&
    value.source === "bundled_openai_manifest" &&
    value.manifestPath === OPENAI_MANIFEST_PATH &&
    typeof value.manifestSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.manifestSha256) &&
    typeof value.modelRef === "string" &&
    isFrontierQualificationCandidateModel(value.modelRef) &&
    (modelRef === undefined || value.modelRef === modelRef) &&
    typeof value.modelRowSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.modelRowSha256) &&
    value.api === "openai-responses" &&
    value.endpoint === "https://api.openai.com/v1" &&
    value.status === "available" &&
    value.codeMode === "preferred"
  );
}

export function resolveFrontierModelQualificationFromManifest(params: {
  manifestText: string;
  modelRef: string;
}): FrontierModelQualificationResult {
  if (!isFrontierQualificationCandidateModel(params.modelRef)) {
    return { ok: false, reason: "candidate_out_of_scope" };
  }
  const parsedRef = parseModelCatalogRef(params.modelRef);
  if (!parsedRef || parsedRef.provider !== "openai") {
    return { ok: false, reason: "candidate_out_of_scope" };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(params.manifestText);
  } catch {
    return { ok: false, reason: "manifest_invalid" };
  }
  const providers =
    isRecord(manifest) && isRecord(manifest.modelCatalog)
      ? manifest.modelCatalog.providers
      : undefined;
  const provider = isRecord(providers) ? providers.openai : undefined;
  if (!isRecord(provider) || !Array.isArray(provider.models)) {
    return { ok: false, reason: "manifest_invalid" };
  }
  if (provider.api !== "openai-responses" || provider.baseUrl !== "https://api.openai.com/v1") {
    return { ok: false, reason: "route_unsupported" };
  }
  const model = provider.models.find((entry) => isRecord(entry) && entry.id === parsedRef.modelId);
  if (!isRecord(model)) {
    return { ok: false, reason: "model_missing" };
  }
  if (model.status !== undefined && model.status !== "available") {
    return { ok: false, reason: "model_unavailable" };
  }
  const compat = isRecord(model.compat) ? model.compat : undefined;
  if (compat?.codeMode !== "preferred") {
    return { ok: false, reason: "code_mode_unsupported" };
  }
  const normalizedRow = {
    api: "openai-responses",
    codeMode: "preferred",
    endpoint: "https://api.openai.com/v1",
    id: parsedRef.modelId,
    modelRef: params.modelRef,
    status: "available",
  } as const;
  return {
    ok: true,
    receipt: {
      api: normalizedRow.api,
      codeMode: normalizedRow.codeMode,
      endpoint: normalizedRow.endpoint,
      manifestPath: OPENAI_MANIFEST_PATH,
      manifestSha256: sha256(params.manifestText),
      modelRef: normalizedRow.modelRef,
      modelRowSha256: sha256(canonicalJson(normalizedRow)),
      source: "bundled_openai_manifest",
      status: normalizedRow.status,
      version: 1,
    },
  };
}

export async function resolveFrontierModelQualification(
  modelRef: string,
): Promise<FrontierModelQualificationResult> {
  return resolveFrontierModelQualificationFromManifest({
    manifestText: await fs.readFile(OPENAI_MANIFEST_URL, "utf8"),
    modelRef,
  });
}
