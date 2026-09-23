import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  resolveQaConvexBrokerConnection,
  runQaConvexLookup,
  type QaConvexLookup,
} from "./qa-credentials-bootstrap.js";

const runQaConvexCliLookup: QaConvexLookup = async (args, options) =>
  runQaConvexLookup(args, options, async (command, argv, execution) => {
    const result = await runUtf8CommandWithTimeout([command, ...argv], {
      cwd: execution.cwd,
      baseEnv: execution.env,
      env: {},
      signal: execution.signal,
      timeoutMs: execution.timeoutMs,
      maxOutputBytes: 64 * 1024,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    });
    if (result.cleanup === "uncertain") {
      throw Object.assign(new Error("Convex helper cleanup was not confirmed."), {
        code: "CLEANUP_UNCONFIRMED",
      });
    }
    return {
      status: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.termination === "timeout" || result.termination === "no-output-timeout",
    };
  });

export async function resolveQaConvexCredentialEnv(
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; signal?: AbortSignal },
) {
  const connection = await resolveQaConvexBrokerConnection({
    env,
    cwd: options.cwd ?? process.cwd(),
    signal: options.signal,
    runConvexCliImpl: runQaConvexCliLookup,
  });
  return {
    ...env,
    OPENCLAW_QA_CONVEX_SITE_URL: connection.siteUrl,
    OPENCLAW_QA_CONVEX_SECRET_CI: connection.secret,
  };
}
