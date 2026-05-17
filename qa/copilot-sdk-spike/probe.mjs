import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import q1 from './probes/q1.mjs';
import q2 from './probes/q2.mjs';
import q3 from './probes/q3.mjs';
import q4 from './probes/q4.mjs';
import q5 from './probes/q5.mjs';
import q6 from './probes/q6.mjs';
import q7 from './probes/q7.mjs';
import q8 from './probes/q8.mjs';
import q9 from './probes/q9.mjs';
import q10 from './probes/q10.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'probe-output');
const LIVE_ENABLED = process.env.OPENCLAW_LIVE_TEST === '1';
const DEFAULT_MODEL = process.env.OPENCLAW_SPIKE_MODEL || 'gpt-4.1';
const MAX_ESTIMATED_TOKENS = 5000;
const probes = [q1, q2, q3, q4, q5, q6, q7, q8, q9, q10];
let sdkModulePromise;

/** Run the Copilot SDK capability probe suite. */
async function main() {
  const runId = utcStamp();
  const state = {
    runId,
    estimatedTokens: 0,
    abortedAt: null,
    results: [],
  };

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const probe of probes) {
    const result = await runProbe(probe, state);
    state.results.push(result);
    if (result.status === 'aborted-cost-cap') {
      state.abortedAt = probe.id;
      break;
    }
  }

  await rm(path.join(OUTPUT_DIR, '.runtime', runId), {
    force: true,
    recursive: true,
  });
  await rm(path.join(OUTPUT_DIR, '.runtime'), {
    force: true,
    recursive: true,
  });

  const summary = {
    runId,
    liveEnabled: LIVE_ENABLED,
    defaultModel: DEFAULT_MODEL,
    maxEstimatedTokens: MAX_ESTIMATED_TOKENS,
    estimatedTokensCommitted: state.estimatedTokens,
    abortedAt: state.abortedAt,
    probes: state.results,
  };
  await writeJson(path.join(OUTPUT_DIR, `RUN-${runId}.json`), summary);
  console.log(JSON.stringify(summary, null, 2));
}

/** Execute one probe and persist its JSON result. */
async function runProbe(probe, state) {
  const outputPath = path.join(OUTPUT_DIR, `${probe.id}-${probe.slug}.json`);
  const logPath = path.join(OUTPUT_DIR, `${probe.id}-${probe.slug}.log`);
  const ctx = createContext(state.runId, probe, logPath);

  if (probe.requiresLive && !LIVE_ENABLED) {
    const skipped = {
      id: probe.id,
      status: 'skipped-not-live',
      evidence: {
        liveEnabled: false,
      },
      observed: 'Live probe skipped because OPENCLAW_LIVE_TEST is not set to 1.',
      conclusion: 'Re-run with OPENCLAW_LIVE_TEST=1 to exercise the live SDK path.',
    };
    await writeJson(outputPath, skipped);
    return skipped;
  }

  if (probe.requiresLive && state.estimatedTokens + probe.maxEstimatedTokens > MAX_ESTIMATED_TOKENS) {
    const aborted = {
      id: probe.id,
      status: 'aborted-cost-cap',
      at: probe.id,
      evidence: {
        estimatedTokensSoFar: state.estimatedTokens,
        nextProbeEstimate: probe.maxEstimatedTokens,
        maxEstimatedTokens: MAX_ESTIMATED_TOKENS,
      },
      observed: 'The next live probe would exceed the per-run estimated token cap.',
      conclusion: 'Stop the run and start a smaller live batch if this probe still needs evidence.',
    };
    await writeJson(outputPath, aborted);
    return aborted;
  }

  if (probe.requiresLive) {
    state.estimatedTokens += probe.maxEstimatedTokens;
    await ctx.log(`estimated max tokens: ${probe.maxEstimatedTokens}; cumulative: ${state.estimatedTokens}`);
  }

  try {
    const payload = await probe.run(ctx);
    const result = {
      id: probe.id,
      status: payload.status || 'ok',
      evidence: payload.evidence ?? null,
      observed: payload.observed ?? null,
      conclusion: payload.conclusion ?? null,
    };
    await writeJson(outputPath, result);
    return result;
  } catch (error) {
    const failure = {
      id: probe.id,
      status: 'error',
      error: stringifyError(error),
    };
    await ctx.log('probe failed', failure);
    await writeJson(outputPath, failure);
    return failure;
  }
}

/** Build the helper context passed to one probe module. */
function createContext(runId, probe, logPath) {
  const runtimeRoot = path.join(OUTPUT_DIR, '.runtime', runId, probe.id);
  return {
    id: probe.id,
    slug: probe.slug,
    description: probe.description,
    requiresLive: probe.requiresLive,
    defaultModel: DEFAULT_MODEL,
    liveEnabled: LIVE_ENABLED,
    projectRoot: PROJECT_ROOT,
    outputDir: OUTPUT_DIR,
    createClient,
    createTempDir: async (label = 'temp') => {
      const target = path.join(runtimeRoot, label);
      await mkdir(target, { recursive: true });
      return target;
    },
    delay,
    findSnippet,
    loadSdk,
    log: createLogger(logPath),
    permissionApproved: () => ({ kind: 'approved' }),
    readInstalledText: async (relativePath) =>
      readFile(path.join(PROJECT_ROOT, 'node_modules', '@github', 'copilot-sdk', relativePath), 'utf8'),
    sanitize,
    stringifyError,
    walkTree,
    withWatchdog,
    writeJson,
  };
}

/** Create a Copilot SDK client with the provided options. */
async function createClient(options = {}) {
  const { CopilotClient } = await loadSdk();
  return new CopilotClient(options);
}

/** Append one line to a probe-local log file. */
function createLogger(logPath) {
  return async (message, data) => {
    const rendered = data === undefined ? '' : ` ${inspect(sanitize(data), { depth: 8, breakLength: 120 })}`;
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}${rendered}\n`, 'utf8');
  };
}

/** Wait for a fixed amount of time. */
function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Extract a nearby declaration snippet from an installed text file. */
function findSnippet(text, token, radius = 420) {
  const index = text.indexOf(token);
  if (index === -1) {
    return null;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).trim();
}

/** Lazily import the Copilot SDK once for the whole probe run. */
async function loadSdk() {
  sdkModulePromise ||= import('@github/copilot-sdk');
  return sdkModulePromise;
}

/** Convert supported values into JSON-safe probe evidence. */
function sanitize(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, currentValue) => {
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack,
          };
        }
        if (typeof currentValue === 'bigint') {
          return currentValue.toString();
        }
        if (typeof currentValue === 'function') {
          return `[Function ${currentValue.name || 'anonymous'}]`;
        }
        return currentValue;
      }),
    );
  } catch {
    return inspect(value, { depth: 8, breakLength: 120 });
  }
}

/** Convert an error-like value into a stable string. */
function stringifyError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return inspect(error, { depth: 8, breakLength: 120 });
}

/** Format a UTC timestamp for filenames. */
function utcStamp() {
  return new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

/** Run an async operation with an outer watchdog timeout. */
async function withWatchdog(label, milliseconds, operation) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${milliseconds}ms`));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Recursively walk a directory tree into a JSON-friendly object. */
async function walkTree(rootPath) {
  const details = await stat(rootPath);
  if (!details.isDirectory()) {
    return {
      path: rootPath,
      type: 'file',
      size: details.size,
    };
  }

  const children = await readdir(rootPath, { withFileTypes: true });
  const entries = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = path.join(rootPath, child.name);
    if (child.isDirectory()) {
      entries.push({
        path: childPath,
        type: 'directory',
        entries: await walkTree(childPath),
      });
      continue;
    }

    const childStat = await stat(childPath);
    entries.push({
      path: childPath,
      type: child.isSymbolicLink() ? 'symlink' : 'file',
      size: childStat.size,
    });
  }

  return entries;
}

/** Write pretty JSON with a trailing newline. */
async function writeJson(targetPath, payload) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
