import fs from "node:fs";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

export const NODE_DIAGNOSTIC_REPORT_GRACE_MS = 2_000;

type NodeDiagnosticReport = {
  threadId?: number;
  javascriptStack: Record<string, unknown>;
  nativeStack: unknown[];
  libuv: unknown[];
  workers: NodeDiagnosticReport[];
};

function projectDiagnosticReport(report: unknown): NodeDiagnosticReport | undefined {
  if (
    !isRecord(report) ||
    !isRecord(report.javascriptStack) ||
    !Array.isArray(report.nativeStack) ||
    !Array.isArray(report.libuv)
  ) {
    return undefined;
  }
  // Reports also contain argv, environment, host, and network metadata; never log those sections.
  const threadId = isRecord(report.header) ? report.header.threadId : undefined;
  return {
    ...(typeof threadId === "number" ? { threadId } : {}),
    javascriptStack: report.javascriptStack,
    nativeStack: report.nativeStack,
    libuv: report.libuv.map((handle) => {
      if (!isRecord(handle)) {
        return handle;
      }
      // Node's network exclusion flag retains socket and named-pipe endpoints.
      const { localEndpoint: _local, remoteEndpoint: _remote, ...execution } = handle;
      return execution;
    }),
    workers: Array.isArray(report.workers)
      ? report.workers.map(projectDiagnosticReport).filter((worker) => worker !== undefined)
      : [],
  };
}

export function collectNodeDiagnosticReport(
  reportPath: string,
  minimumWaitMs = 0,
): Promise<string> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const finish = (report: string) => {
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(report);
    };
    const poll = setInterval(() => {
      try {
        const report = projectDiagnosticReport(JSON.parse(fs.readFileSync(reportPath, "utf8")));
        if (report && performance.now() - startedAt >= minimumWaitMs) {
          finish(JSON.stringify(report, null, 2));
        }
      } catch {
        // Node writes directly to the report file; it may not exist or be complete yet.
      }
    }, 50);
    const deadline = setTimeout(
      () =>
        finish(
          `No complete Node diagnostic report captured within ${NODE_DIAGNOSTIC_REPORT_GRACE_MS}ms.`,
        ),
      NODE_DIAGNOSTIC_REPORT_GRACE_MS,
    );
  });
}
