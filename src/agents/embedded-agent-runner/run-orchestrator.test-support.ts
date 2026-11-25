type Run = typeof import("./run.js").runEmbeddedAgent;

export function withTestAdmission(
  run: Run,
  prepare: typeof import("../admitted-run-context.js").prepareSystemAgentRunAdmission,
  source: string,
): Run {
  return async (params) => {
    const admission = prepare(params.config ?? {}, params.runId, params.agentId ?? "main", source);
    try {
      return await run({ ...params, preparedRunAdmission: admission });
    } finally {
      admission.close();
    }
  };
}
