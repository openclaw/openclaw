import { stripVTControlCharacters } from "node:util";

const FILE = /^(?:src|test|extensions|packages|ui)\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export function isNodeTestEvidencePath(file) {
  return typeof file === "string" && FILE.test(file) && !file.includes("..");
}

function completeInvocations(rows) {
  const receipts = rows.filter((row) => row.stream === "completion");
  if (receipts.length !== 1) {
    return false;
  }
  let receipt;
  try {
    receipt = JSON.parse(receipts[0].text);
  } catch {
    return false;
  }
  if (
    receipt?.version !== 1 ||
    ![receipt.planned, receipt.completed, receipt.invocations, receipt.failedInvocations].every(
      (count) => Number.isSafeInteger(count) && count > 0 && count <= 800,
    ) ||
    receipt.completed !== receipt.planned ||
    receipt.invocations < receipt.planned ||
    receipt.failedInvocations > receipt.invocations
  ) {
    return false;
  }
  const streams = new Map();
  for (const { stream, text } of rows) {
    if (!stream || stream === "completion") {
      continue;
    }
    // Precise targets use the same label for the outer framing and child output.
    if (text === "begin" || /^end \(exit \d+\)$/u.test(text)) {
      continue;
    }
    let state = streams.get(stream);
    if (/^\[test\] (?:starting |(?:passed|failed|skipped) \d+ Vitest shards?\b)/u.test(text)) {
      if (!state) {
        state = { invocations: [], terminal: null, trailer: false };
        streams.set(stream, state);
      }
    }
    if (!state) {
      // Before a child starts, only native preparation and outer telemetry are
      // evidence. An unaccounted stream must not hide an additional failure.
      if (
        text === "" ||
        /^\[test\] preflight test\/vitest\/vitest\.[\w.-]+\.ts$/u.test(text) ||
        /^\[test\] running \d+ (?:Vitest shards|exact-target plans) with parallelism \d+(?: and joined exclusive barriers)?$/u.test(
          text,
        ) ||
        (stream === "resources" &&
          /^logicalCpuCount=\d+ totalMemoryBytes=\d+ requested plans=\d+ admitted plans=\d+$/u.test(
            text,
          )) ||
        (stream === "resource-snapshot" && /^\{"phase":"(?:start|end)",/u.test(text)) ||
        (stream === "cache" &&
          /^(?:cloned restored Vitest seed into \d+ isolated lane\(s\)|(?:vitest|node-compile) \d+ -> \d+ bytes; removed \d+ files)$/u.test(
            text,
          )) ||
        (stream.startsWith("node-subset:") &&
          text === "skipped (native shard has no Node-only files)")
      ) {
        continue;
      }
      return false;
    }
    if (state.terminal) {
      if (text === "[test] FAILED (exit 1)" && state.terminal.kind === "failed" && !state.trailer) {
        state.trailer = true;
      } else if (text !== "") {
        return false;
      }
      continue;
    }
    const current = state.invocations.at(-1);
    if (
      current &&
      (current.files !== undefined || current.tests !== undefined) &&
      text !== "" &&
      !/^(?:Test Files|Tests)\s/u.test(text) &&
      !/^Start at\s+\d{2}:\d{2}:\d{2}$/u.test(text) &&
      !/^Duration\s+\d+(?:\.\d+)?(?:ms|s)\b/u.test(text) &&
      !/^\[test\] (?:starting |(?:passed|failed|skipped) \d+ Vitest shards?\b)/u.test(text) &&
      text !== "[vitest-workers] verifying completed generation before cleanup" &&
      text !== "[vitest-workers] retained completed compiler outputs for reuse"
    ) {
      return false;
    }
    if (text.startsWith("[test] starting ")) {
      state.invocations.push({ files: undefined, tests: undefined });
    }
    const summary = /^(Test Files|Tests)\s+.+\(\d+\)$/u.exec(text);
    if (summary) {
      const active = state.invocations.at(-1);
      if (!active) {
        return false;
      }
      const key = summary[1] === "Test Files" ? "files" : "tests";
      const failed = /\b[1-9]\d* failed\b/u.test(text);
      if (active[key] !== undefined && active[key] !== failed) {
        return false;
      }
      active[key] = failed;
    }
    const terminal = /^\[test\] (passed|failed|skipped) (\d+) Vitest shards?\b/u.exec(text);
    if (terminal) {
      state.terminal = { kind: terminal[1], count: Number(terminal[2]) };
    }
  }
  let failedStreams = 0;
  for (const state of streams.values()) {
    if (
      !state.terminal ||
      state.invocations.some(
        (invocation) =>
          typeof invocation.files !== "boolean" ||
          typeof invocation.tests !== "boolean" ||
          invocation.files !== invocation.tests,
      )
    ) {
      return false;
    }
    const failed = state.invocations.filter((invocation) => invocation.tests).length;
    if (state.terminal.kind === "failed") {
      if (!state.trailer || failed === 0 || state.terminal.count !== failed) {
        return false;
      }
      failedStreams++;
    } else if (failed !== 0 || state.terminal.count !== state.invocations.length) {
      return false;
    }
  }
  return streams.size === receipt.invocations && failedStreams === receipt.failedInvocations;
}

/** Parse native reports; PR acceptance additionally requires complete execution evidence. */
export function parseNodeFailureReport(log, requireComplete) {
  const rows = stripVTControlCharacters(log)
    .split("\n")
    .map((line) => {
      const raw = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s/u, "");
      const match = /^\[shard:([^\]]+)\]\s*(.*)$/u.exec(raw);
      return { stream: match?.[1] ?? "", text: (match?.[2] ?? raw).trim() };
    });
  if (rows.some(({ stream, text }) => !stream && /^(?:\w*Error:|ERR_[A-Z_]+\b)/u.test(text))) {
    return [];
  }
  if (requireComplete && !completeInvocations(rows)) {
    return [];
  }
  const streams = new Map();
  for (const row of rows) {
    const lines = streams.get(row.stream) ?? [];
    lines.push(row.text);
    streams.set(row.stream, lines);
  }
  const signatures = [];
  const assertionMessages = new Set();
  let failedCount = 0;
  let failureHeaders = 0;
  for (const lines of streams.values()) {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/^(?:\w*Error:|ERR_[A-Z_]+\b)/u.test(line) && !/^FAIL\s/u.test(lines[index - 1] ?? "")) {
        return [];
      }
      if (
        /Unhandled (?:Error|Rejection)|Failed Suites|Worker exited|heap out of memory|Segmentation fault|failed to spawn|error TS\d+/u.test(
          line,
        )
      ) {
        return [];
      }
      const summary = /^Tests\s+(\d+) failed(?:\s|$)/u.exec(line);
      if (summary) {
        failedCount += Number(summary[1]);
      }
      if (!/^FAIL\s/u.test(line)) {
        continue;
      }
      failureHeaders++;
      const failure = /^FAIL\s+(?:\S+\s+)?(\S+) > (.+)$/u.exec(line);
      const message = lines[index + 1];
      if (
        !failure ||
        !isNodeTestEvidencePath(failure[1]) ||
        !/^(?:AssertionError|Error|TypeError|RangeError): .+/u.test(message ?? "")
      ) {
        return [];
      }
      let end = index + 2;
      while (
        end < lines.length &&
        !/^(?:FAIL\s|Test Files\s|Tests\s|\[test\]|⎯+(?:\[\d+\/\d+\])?⎯*$)/u.test(lines[end])
      ) {
        end++;
      }
      const assertion = lines
        .slice(index + 1, end)
        .join("\n")
        .trim();
      assertionMessages.add(message);
      signatures.push({ kind: "vitest", file: failure[1], test: `${failure[2]} :: ${assertion}` });
    }
  }
  if (
    rows.some(
      ({ text }) =>
        text.startsWith("##[error]") &&
        text !== "##[error]Process completed with exit code 1." &&
        !assertionMessages.has(text.slice(9)),
    )
  ) {
    return [];
  }
  return failedCount > 0 && failureHeaders === failedCount && signatures.length === failedCount
    ? signatures
    : [];
}
