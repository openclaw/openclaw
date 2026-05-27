import {
  createQaDockerRuntime,
  type QaDockerFetchLike as FetchLike,
  type QaDockerRunCommand as RunCommand,
} from "openclaw/plugin-sdk/qa-runner-shared-runtime";

export type { FetchLike, RunCommand };

const dockerRuntime = createQaDockerRuntime({
  auditContext: "qa-lab-docker-health-check",
  commandTimeoutMs: null,
});

export const {
  execCommand,
  fetchHealthUrl,
  resolveComposeServiceUrl,
  resolveHostPort,
  waitForDockerServiceHealth,
  waitForHealth,
} = dockerRuntime;
