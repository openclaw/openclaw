const DEFAULT_OUTPUT_CAPTURE_LIMIT = 200_000;

const fatalOutputPatterns = [
  /FATAL ERROR:.*heap out of memory/i,
  /Allocation failed - JavaScript heap out of memory/i,
  /node::OOMErrorHandler/i,
];

export function appendCapturedOutput(current, chunk, limit = DEFAULT_OUTPUT_CAPTURE_LIMIT) {
  if (!chunk) {
    return current;
  }
  const next = `${current}${chunk}`;
  if (next.length <= limit) {
    return next;
  }
  return next.slice(-limit);
}

export function hasFatalTestRunOutput(output) {
  return fatalOutputPatterns.some((pattern) => pattern.test(output));
}

export function resolveTestRunExitCode({ code, signal, output }) {
  if (typeof code === "number" && code !== 0) {
    return code;
  }
  if (signal) {
    return 1;
  }
  if (hasFatalTestRunOutput(output)) {
    return 1;
  }
  return code ?? 0;
}
