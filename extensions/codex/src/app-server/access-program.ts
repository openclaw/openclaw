import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** A local admission failure, not a failed model request or credential. */
export class CodexAccessProgramUnavailableError extends Error {}

/** Session override wins; an empty model setting leaves the native default unchanged. */
export function resolveCodexCyberAccessProgram(
  params: EmbeddedRunAttemptParamsV2,
): "standard" | "daybreakBlue" | "daybreakRed" | undefined {
  const configured = params.runtimePlan?.transport.resolveExtraParams().accessPrograms;
  const programs = asOptionalRecord(configured);
  if (
    configured !== undefined &&
    (!programs ||
      Object.keys(programs).some((key) => key !== "cyber") ||
      (programs.cyber !== undefined &&
        programs.cyber !== "standard" &&
        programs.cyber !== "daybreak_blue" &&
        programs.cyber !== "daybreak_red"))
  ) {
    throw new Error(
      'OpenAI params.accessPrograms must be {} or { cyber: "standard" | "daybreak_blue" | "daybreak_red" }.',
    );
  }
  const program = params.cyberAccessProgram ?? programs?.cyber;
  return program === "daybreak_blue"
    ? "daybreakBlue"
    : program === "daybreak_red"
      ? "daybreakRed"
      : program === "standard"
        ? "standard"
        : undefined;
}
