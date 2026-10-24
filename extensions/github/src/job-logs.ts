import type { ControlUiLinkReaderDocument } from "openclaw/plugin-sdk/control-ui-link-reader";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  ControlUiGitHubError,
  discardResponse,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  GITHUB_REQUEST_TIMEOUT_MS,
  isRecord,
  readBoundedResponse,
  readGitHubJsonResponse,
  requiredString,
} from "./github-api.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import { parseGitHubReadTarget, type GitHubJobTarget } from "./targets.js";

const LOG_MAX_BYTES = 64 * 1024;
const LOG_HOSTS = ["*.blob.core.windows.net", "*.actions.githubusercontent.com"];

function unavailable(): ControlUiGitHubError {
  return new ControlUiGitHubError(502, "GitHub job logs are unavailable; open the job on GitHub");
}

async function readLogTail(
  location: string,
  identity: ControlUiGitHubPreviewIdentity | undefined,
  fetchImpl: typeof fetch,
): Promise<{ text: string; totalBytes: number; start: number }> {
  const url = URL.parse(location);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname.endsWith(".blob.core.windows.net") ||
      url.hostname.endsWith(".actions.githubusercontent.com")
    )
  ) {
    throw unavailable();
  }
  const request = async (init: RequestInit) => {
    await identity?.revalidate();
    identity?.assertSelected();
    return fetchWithSsrFGuard({
      url: url.href,
      fetchImpl,
      requireHttps: true,
      maxRedirects: 0,
      timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
      signal: identity?.signal,
      beforeRequest: () => identity?.assertSelected(),
      capture: false,
      policy: { hostnameAllowlist: LOG_HOSTS },
      // The signed storage URL is never returned, logged, or sent GitHub credentials.
      init: { ...init, credentials: "omit", redirect: "error" },
    });
  };
  const head = await request({ method: "HEAD" });
  let totalBytes: number;
  try {
    const length = head.response.headers.get("content-length");
    totalBytes = length && /^\d+$/u.test(length) ? Number(length) : Number.NaN;
    if (!head.response.ok || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw unavailable();
    }
  } finally {
    await discardResponse(head.response);
    await head.release();
  }
  if (totalBytes === 0) {
    return { text: "", totalBytes, start: 0 };
  }
  const start = Math.max(0, totalBytes - LOG_MAX_BYTES);
  const download = await request({ headers: { Range: `bytes=${start}-${totalBytes - 1}` } });
  try {
    const response = download.response;
    const range = `bytes ${start}-${totalBytes - 1}/${totalBytes}`;
    if (
      !(
        (response.status === 206 && response.headers.get("content-range") === range) ||
        (response.status === 200 && start === 0)
      )
    ) {
      throw unavailable();
    }
    const bytes = await readBoundedResponse(response, LOG_MAX_BYTES);
    if (bytes.length !== totalBytes - start) {
      throw unavailable();
    }
    let text = bytes.toString("utf8");
    // A byte range can begin inside UTF-8 or a credential. Deliver complete lines only.
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return { text: redactToolPayloadText(text), totalBytes, start };
  } finally {
    await discardResponse(download.response);
    await download.release();
  }
}

export async function loadGitHubJobLog(
  target: GitHubJobTarget,
  identity: ControlUiGitHubPreviewIdentity | undefined,
  fetchImpl: typeof fetch,
  readPublicRepository: (expectedId?: number) => Promise<number>,
): Promise<ControlUiLinkReaderDocument> {
  if (parseGitHubReadTarget(target)?.kind !== "job") {
    throw new ControlUiGitHubError(400, "Invalid GitHub workflow job target");
  }
  const repositoryId = await readPublicRepository();
  const repositoryUrl = `${GITHUB_API_ORIGIN}/repos/${target.owner}/${target.repo}`;
  const jobUrl = `${repositoryUrl}/actions/jobs/${target.jobId}`;
  const url = `https://github.com/${target.owner}/${target.repo}/actions/runs/${target.runId}/job/${target.jobId}`;
  const request = (path: string, redirect: "follow" | "manual" = "follow") =>
    fetchGitHubApi(
      path,
      fetchImpl,
      identity?.token,
      async () => {
        throw unavailable();
      },
      identity,
      undefined,
      undefined,
      undefined,
      GITHUB_API_ORIGIN,
      redirect,
    );
  const job = await readGitHubJsonResponse(await request(jobUrl));
  if (
    !isRecord(job) ||
    job.id !== target.jobId ||
    job.run_id !== target.runId ||
    typeof job.url !== "string" ||
    job.url.toLowerCase() !== jobUrl.toLowerCase() ||
    typeof job.run_url !== "string" ||
    job.run_url.toLowerCase() !== `${repositoryUrl}/actions/runs/${target.runId}`.toLowerCase() ||
    typeof job.head_sha !== "string" ||
    !/^[a-f\d]{40}$/iu.test(job.head_sha)
  ) {
    throw new ControlUiGitHubError(502, "GitHub returned a different or incomplete workflow job");
  }
  const name = requiredString(job, "name");
  const status = requiredString(job, "status");
  if (status !== "completed") {
    throw new ControlUiGitHubError(
      502,
      "GitHub job is still running; read its logs after it completes",
    );
  }
  const conclusion = requiredString(job, "conclusion");
  let log: Awaited<ReturnType<typeof readLogTail>>;
  try {
    const response = await request(jobUrl + "/logs", "manual");
    try {
      if (response.status !== 302) {
        if (!response.ok) {
          await readGitHubJsonResponse(response);
        }
        throw unavailable();
      }
      log = await readLogTail(response.headers.get("location") ?? "", identity, fetchImpl);
    } finally {
      await discardResponse(response);
    }
  } catch (error) {
    identity?.signal?.throwIfAborted();
    identity?.assertSelected();
    // Transport errors may embed the signed download URL. Never send them to a caller.
    if (error instanceof ControlUiGitHubError) {
      throw error;
    }
    throw unavailable();
  }
  await readPublicRepository(repositoryId);
  await identity?.revalidate();
  identity?.assertSelected();
  const partial = log.start > 0;
  const summary = partial
    ? `Partial log: complete lines from the last ${LOG_MAX_BYTES} bytes of ${log.totalBytes} bytes. Earlier output is omitted.`
    : `Complete available job log (${log.totalBytes} bytes).`;
  return {
    url,
    title: name,
    subtitle: `${target.owner}/${target.repo} · job ${target.jobId}`,
    revision: job.head_sha,
    metadata: [
      { label: "Run", value: String(target.runId) },
      { label: "Job", value: String(target.jobId) },
      { label: "Status", value: status },
      { label: "Conclusion", value: conclusion },
    ],
    body: `${summary}\n\n${log.text
      .split("\n")
      .map((line) => "    " + line)
      .join("\n")}`,
    bodyTruncated: partial,
    partial,
  };
}
