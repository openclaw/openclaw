import type { ControlUiLinkReaderDocument } from "openclaw/plugin-sdk/control-ui-link-reader";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ControlUiGitHubError,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  isRecord,
  readGitHubJsonResponse,
} from "./github-api.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import { isPublicGitHubRepository } from "./preview.js";
import type { GitHubCodeScanningTarget } from "./targets.js";

const PAGE_SIZE = 30;
const BODY_LIMIT = 32 * 1024;

function analysisMetadata(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    typeof value.id !== "number" ||
    value.id <= 0 ||
    typeof value.commit_sha !== "string" ||
    !/^[a-f\d]{40}$/iu.test(value.commit_sha)
  ) {
    throw new ControlUiGitHubError(502, "GitHub returned invalid analysis metadata");
  }
  // Diagnostics are metadata, not the SARIF source, result locations, or database.
  return Object.fromEntries(
    [
      "id",
      "commit_sha",
      "ref",
      "category",
      "analysis_key",
      "error",
      "warning",
      "created_at",
      "results_count",
      "rules_count",
      "sarif_id",
    ].flatMap((key) =>
      typeof value[key] === "string" || typeof value[key] === "number" ? [[key, value[key]]] : [],
    ),
  );
}

export async function loadGitHubCodeScanning(
  target: GitHubCodeScanningTarget,
  identity: ControlUiGitHubPreviewIdentity | undefined,
  fetchImpl: typeof fetch,
): Promise<ControlUiLinkReaderDocument> {
  if (!identity?.token || !identity.readerAccount || identity.optionalAuth) {
    throw new ControlUiGitHubError(
      403,
      "Code Scanning diagnostics require the agent's managed GitHub identity with Code scanning alerts read access",
    );
  }
  const repositoryUrl = `${GITHUB_API_ORIGIN}/repos/${target.owner}/${target.repo}`;
  const base = `${repositoryUrl}/code-scanning`;
  const url =
    target.operation === "analyses"
      ? `${base}/analyses?${new URLSearchParams({ ref: target.ref, page: String(target.page) })}`
      : target.operation === "analysis"
        ? `${base}/analyses/${target.analysisId}`
        : `${base}/sarifs/${target.sarifId}`;
  const read = async (href: string) =>
    readGitHubJsonResponse(
      await fetchGitHubApi(
        href,
        fetchImpl,
        identity.token,
        async () => {
          throw new ControlUiGitHubError(
            409,
            "GitHub repository target changed; retry with its current name",
          );
        },
        identity,
        undefined,
        undefined,
        undefined,
        GITHUB_API_ORIGIN,
      ),
      256 * 1024,
    );
  const repository = await read(repositoryUrl);
  if (!isPublicGitHubRepository(repository)) {
    throw new ControlUiGitHubError(404, "The GitHub reader requires a public repository");
  }
  const value = await read(target.operation === "analyses" ? `${url}&per_page=${PAGE_SIZE}` : url);
  let data: Record<string, unknown>;
  let partial = false;
  if (target.operation === "analyses") {
    if (!Array.isArray(value) || value.length > PAGE_SIZE) {
      throw new ControlUiGitHubError(502, "GitHub returned invalid analysis metadata");
    }
    partial = value.length === PAGE_SIZE;
    data = {
      analyses: value.map(analysisMetadata),
      ref: target.ref,
      page: target.page,
      nextPage: partial && target.page < 50 ? target.page + 1 : null,
      limited: partial && target.page === 50,
    };
  } else if (target.operation === "analysis") {
    data = analysisMetadata(value);
    if (data.id !== target.analysisId) {
      throw new ControlUiGitHubError(502, "GitHub returned a different analysis");
    }
  } else {
    if (
      !isRecord(value) ||
      !["pending", "complete", "failed"].includes(String(value.processing_status)) ||
      (value.errors !== undefined &&
        (!Array.isArray(value.errors) || !value.errors.every((error) => typeof error === "string")))
    ) {
      throw new ControlUiGitHubError(502, "GitHub returned invalid SARIF upload status");
    }
    data = {
      sarifId: target.sarifId,
      processingStatus: value.processing_status,
      errors: value.errors ?? [],
    };
  }
  const text = redactToolPayloadText(
    JSON.stringify(data, null, 2).split(identity.token).join("[REDACTED]"),
  );
  const currentRepository = await read(repositoryUrl);
  if (
    !isPublicGitHubRepository(currentRepository) ||
    !isRecord(currentRepository) ||
    !isRecord(repository) ||
    currentRepository.id !== repository.id
  ) {
    throw new ControlUiGitHubError(
      404,
      "GitHub repository access changed during the diagnostic read",
    );
  }
  await identity.revalidate();
  identity.assertSelected();
  const truncated = text.length > BODY_LIMIT;
  return {
    url,
    title: "GitHub Code Scanning diagnostics",
    subtitle: `${target.owner}/${target.repo}`,
    metadata: [
      { label: "Reader account ID", value: String(identity.readerAccount.accountId) },
      { label: "Reader source", value: identity.readerAccount.source },
    ],
    body: truncateUtf16Safe(text, BODY_LIMIT),
    bodyTruncated: truncated,
    partial: partial || truncated,
  };
}
