import type { DiagnosticsTimelineOptions as EmbeddedAgentPreparationTimingOptions } from "../../../infra/diagnostics-timeline.js";
import { measureDiagnosticsTimelineSpan } from "../../../infra/diagnostics-timeline.js";

/** Measures async pre-provider work under the canonical agent preparation span. */
export function measureEmbeddedAgentPreparation<T>(
  stage: string,
  run: () => Promise<T> | T,
  options: EmbeddedAgentPreparationTimingOptions = {},
): Promise<T> {
  return measureDiagnosticsTimelineSpan("agent.prepare", run, {
    config: options.config,
    env: options.env,
    phase: "agent.prepare",
    attributes: { stage },
  });
}
