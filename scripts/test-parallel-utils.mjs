const DEFAULT_OUTPUT_CAPTURE_LIMIT = 200_000;

const fatalOutputPatterns = [
  /FATAL ERROR:/i,
  /JavaScript heap out of memory/i,
  /node::OOMErrorHandler/i,
  /ERR_WORKER_OUT_OF_MEMORY/i,
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

export function formatCapturedOutputTail(output, maxLines = 60, maxChars = 6000) {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split(/\r?\n/u);
  const tailLines = lines.slice(-maxLines);
  const tail = tailLines.join("\n");
  if (tail.length <= maxChars) {
    return tail;
  }
  return tail.slice(-maxChars);
}

export function resolveTestRunExitCode({ code, signal, output, fatalSeen = false, childError }) {
  if (typeof code === "number" && code !== 0) {
    return code;
  }
  if (childError) {
    return 1;
  }
  if (signal) {
    return 1;
  }
  if (fatalSeen || hasFatalTestRunOutput(output)) {
    return 1;
  }
  return code ?? 0;
}
