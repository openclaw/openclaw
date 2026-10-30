/** Propagate measurement into the compiled Doctor's process and worker boundaries. */
export function createDoctorConfigProbe(options: {
  output: string;
  observer: string | undefined;
  profile: boolean;
}): string {
  return String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const wt = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const root = ${JSON.stringify(options.output)};
const observer = ${JSON.stringify(options.observer ?? "")};
const profile = ${JSON.stringify(options.profile)};
process.env.SQLMEASURE_OUT = root;
const fd = fs.openSync(path.join(root, 'process-' + process.pid + '-' + wt.threadId + '.jsonl'), 'a');
function record(event) {
  fs.writeSync(fd, JSON.stringify({ time: Date.now(), monotonicMs: performance.now(),
    cpu: process.threadCpuUsage(), processCpu: wt.isMainThread ? process.cpuUsage() : undefined,
    pid: process.pid, threadId: wt.threadId, ...event }) + '\n');
}
record({ type: 'start', ppid: process.ppid, mainThread: wt.isMainThread, argv: process.argv });
const ownOptions = '--require=' + JSON.stringify(__filename) +
  (observer ? ' --require=' + JSON.stringify(observer) : '');
function instrumentOptions(value) {
  const options = { ...value, env: { ...(value && value.env || process.env), SQLMEASURE_OUT: root } };
  const old = options.env.NODE_OPTIONS || '';
  options.env.NODE_OPTIONS = old.includes(__filename) ? old : old + ' ' + ownOptions;
  return options;
}
process.env.NODE_OPTIONS = instrumentOptions({ env: process.env }).env.NODE_OPTIONS;
function profileArgs(command, args) {
  return profile && path.basename(command).replace(/\.exe$/i, '') === 'node' &&
    !args.some(arg => arg === '--cpu-prof' || arg.startsWith('--cpu-prof-dir='))
    ? ['--cpu-prof', '--cpu-prof-interval=10000', '--cpu-prof-dir=' + path.join(root, 'profiles'), ...args]
    : args;
}
const nativeSpawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function(options) {
  options = { ...options, args: [options.args[0], ...profileArgs(options.file, options.args.slice(1))] };
  const result = nativeSpawn.call(this, options);
  record({ type: 'child-spawn', childPid: this.pid, command: options.file, args: options.args });
  this.once('exit', (code, signal) => record({ type: 'child-exit', childPid: this.pid, code, signal }));
  return result;
};
const originalSpawn = cp.spawn;
cp.spawn = function(command, args, options) {
  return originalSpawn.call(this, command, args, instrumentOptions(options));
};
const originalSpawnSync = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  return originalSpawnSync.call(this, command, profileArgs(command, args), instrumentOptions(options));
};
const OriginalWorker = wt.Worker;
wt.Worker = class extends OriginalWorker {
  constructor(filename, options = {}) {
    // Node's CLI profiler flags are invalid worker execArgv; the inspector below profiles each worker.
    const inherited = (options.execArgv || process.execArgv).filter(arg => !arg.startsWith('--cpu-prof'));
    const env = options.env && options.env !== wt.SHARE_ENV
      ? { ...options.env, SQLMEASURE_OUT: root } : options.env;
    super(filename, { ...options, env, execArgv: [...inherited, '--require', __filename] });
  }
};
syncBuiltinESMExports();
if (observer) require(observer);
let inspector;
if (profile) {
  const { Session } = require('node:inspector');
  inspector = new Session();
  inspector.connect();
  inspector.post('Profiler.enable');
  inspector.post('Profiler.setSamplingInterval', { interval: 10000 });
  inspector.post('Profiler.start');
}
const timer = profile ? setInterval(() => record({ type: 'cpu-sample' }), 100).unref() : undefined;
process.once('exit', code => {
  if (timer) clearInterval(timer);
  record({ type: 'exit', code });
  if (inspector) {
    inspector.post('Profiler.stop', (error, result) => {
      if (error) record({ type: 'profile-error', message: error.message });
      else fs.writeFileSync(path.join(root, 'profiles', 'inspector-' + process.pid + '-' + wt.threadId + '.cpuprofile'), JSON.stringify(result.profile));
      inspector.disconnect();
    });
  }
});
`;
}
