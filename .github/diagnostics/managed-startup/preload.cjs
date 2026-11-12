'use strict';
// CI-only numeric allocation sampling. Never installed in candidate source.
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const wt = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'profile-config.json'), 'utf8'));
const output = path.join(config.output, 'thread-' + process.pid + '-' + wt.threadId + '.jsonl');
function emit(event) {
  fs.appendFileSync(output, JSON.stringify({ at: Date.now(), pid: process.pid,
    threadId: wt.threadId, main: wt.isMainThread, internal: wt.isInternalThread, ...event }) + '\n', { mode: 0o600 });
}
function deadline() {
  try { return JSON.parse(fs.readFileSync(config.ready, 'utf8')).endAt; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return config.hardEndAt; }
}
if (Date.now() <= deadline()) {
  emit({ kind: 'loaded', node: process.version, executable: process.execPath,
    resourceLimits: wt.resourceLimits, heapLimit: v8.getHeapStatistics().heap_size_limit,
    // No environment values, workerData, application argv, stacks or message content.
    preload: __filename });
  // Independent discovery witness: not merely workers seen by our subclass.
  process.on('worker', worker => emit({ kind: 'worker-observed', childThreadId: worker.threadId }));
  const NativeWorker = wt.Worker;
  class DiagnosticWorker extends NativeWorker {
    constructor(filename, options = {}) {
      // Default inheritance is left to Node (which filters main-only V8 flags).
      // Explicit [] is common in this candidate and would otherwise lose preload.
      const actual = options.execArgv === undefined ? options : { ...options,
        execArgv: [...options.execArgv, '--require', __filename] };
      super(filename, actual);
      const id = this.threadId;
      emit({ kind: 'worker-created', childThreadId: id,
        entry: typeof filename === 'string' && options.eval ? '<eval>' : path.basename(String(filename)),
        explicitExecArgv: options.execArgv !== undefined });
      this.once('online', () => emit({ kind: 'worker-online', childThreadId: id }));
      this.once('exit', code => emit({ kind: 'worker-exit', childThreadId: id, code }));
    }
  }
  wt.Worker = DiagnosticWorker;
  syncBuiltinESMExports();
  let count = 0;
  function sample() {
    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    emit({ kind: 'sample', heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
      external: memory.external, arrayBuffers: memory.arrayBuffers,
      mallocedMemory: heap.malloced_memory, peakMallocedMemory: heap.peak_malloced_memory,
      externalMemory: heap.external_memory, heapLimit: heap.heap_size_limit,
      // RSS is process-wide: emitted once, never summed across workers.
      ...(wt.isMainThread ? { rss: memory.rss } : {}) });
    count++;
    if (Date.now() >= deadline() || count >= 1250) {
      clearInterval(timer);
      emit({ kind: 'sampling-ended' });
    }
  }
  const timer = setInterval(sample, 100);
  timer.unref();
  sample();
}
