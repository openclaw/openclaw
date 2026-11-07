#!/usr/bin/env python3
"""NONQUALIFICATION. Two serial frozen arms; see --help. No dispatch/publication.
Run only on an exclusive, disposable Linux account with a working systemd user
manager, not on the account hosting OpenClaw. Raw evidence remains private.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import time

ARMS = [('b764', 'b764253ddf0edf89887ecc0dcc2a8615ad791bc2'),
        ('e2db', 'e2db37f28cc774d75a54d963817d0f153387a229')]
KOVA = '4b8b1681446b868a44193ed6e97253a6c8bcbbbf'
NODE_SHA = '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6'
OCM_SHA = '05e0bb598fe391c75fe7668e159d7eb09168b4298b5d8d0999786e79e97d0642'
FILTERS = 'scenario:fresh-install,scenario:bundled-plugin-startup'
ACTIVE = None
BASE_ENV = None

# In-process profiler: emitted only for the optional non-root snapshot diagnostic.
SNAPSHOT_PRELOAD = r"""
'use strict';
// Diagnostic-only, in-process Inspector session: no port, attach, or signal handler.
const fs = require('node:fs');
const path = require('node:path');
const { Session } = require('node:inspector');
const { threadId } = require('node:worker_threads');
const dir = path.join(__dirname, 'snapshots');
const prefix = `${process.pid}.${threadId}`;
const request = path.join(dir, `${process.pid}.request`);
const session = new Session();
const startedAt = Date.now();
// These counters cover the whole process; worker receipts must not be summed.
const cpuAtStart = process.cpuUsage();
let checks = 0;
let timer;
function fail(error) {
  if (timer) clearInterval(timer);
  fs.writeFileSync(path.join(dir, `${prefix}.error.json`), JSON.stringify({ pid: process.pid, threadId, code: error.code || 'snapshot-failed' }), { mode: 0o600 });
  session.disconnect();
}
session.connect();
session.post('Profiler.enable', (error) => {
  if (error) return fail(error);
  session.post('Profiler.setSamplingInterval', { interval: 1000 }, (error) => {
    if (error) return fail(error);
    session.post('Profiler.start', (error) => {
      if (error) return fail(error);
      fs.writeFileSync(path.join(dir, `${prefix}.armed.json`), JSON.stringify({ pid: process.pid, threadId, startedAt }), { mode: 0o600 });
      timer = setInterval(() => {
        checks++;
        if (!fs.existsSync(request)) return;
        clearInterval(timer);
        const requestedAt = Date.now();
        const cpuAtRequest = process.cpuUsage();
        session.post('Profiler.stop', (error, result) => {
          if (error) return fail(error);
          const output = path.join(dir, `${prefix}.cpuprofile`);
          fs.writeFileSync(output + '.pending', JSON.stringify(result.profile), { mode: 0o600 });
          fs.renameSync(output + '.pending', output);
          fs.writeFileSync(path.join(dir, `${prefix}.done.json`), JSON.stringify({ pid: process.pid, threadId, startedAt, requestedAt, completedAt: Date.now(), checks, processCpuAtStart: cpuAtStart, processCpuAtRequest: cpuAtRequest, processCpuAtComplete: process.cpuUsage() }), { mode: 0o600 });
          session.disconnect();
        });
      }, 100);
      timer.unref();
    });
  });
});
"""

def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')

def captured(args, env=None, cwd=None):
    return subprocess.check_output(args, env=env, cwd=cwd, stderr=subprocess.PIPE, text=True).strip()

def logged(args, log, env, cwd=None, allowed=False):
    with open(log, 'ab') as out:
        # A private process group lets signal/error cleanup settle Kova before
        # OCM cleanup; otherwise its orphaned controller could start another env.
        child = subprocess.Popen(args, env=env, cwd=cwd, stdout=out, stderr=out,
                                 start_new_session=True)
        try:
            code = child.wait()
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
            raise
    if code and not allowed:
        raise RuntimeError('command failed; inspect private log: ' + str(log))
    return code

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as src:
        for part in iter(lambda: src.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()

def status(real, name, env):
    data = json.loads(captured([real, 'service', 'status', name, '--json'], env))
    if data.get('envName') != name:
        raise RuntimeError('service status returned another environment')
    return data

def receipt(data, env):
    pid = data.get('childPid')
    if not data.get('running') or not isinstance(pid, int):
        raise RuntimeError('missing running gateway PID')
    actual = os.path.realpath('/proc/' + str(pid) + '/exe')
    expected = os.path.realpath(env['CAUSAL_NODE'])
    if actual != expected:
        raise RuntimeError('gateway did not use the exact pinned Node executable')
    # Never retain cmdline or /proc/environ: they can contain private data.
    return {'pid': pid, 'nodeExecutableSha256': sha(actual),
            'startTicks': Path('/proc/' + str(pid) + '/stat').read_text().split(') ', 1)[1].split()[19],
            'capturedAt': time.time()}

def warm_ready(path, expected, env_name, since):
    # A status snapshot alone cannot establish which restart became ready.
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if path.is_file():
            for line in path.read_text().splitlines():
                try:
                    event = json.loads(line)
                    timestamp = datetime.fromisoformat(event.get('timestamp', '').replace('Z', '+00:00')).timestamp()
                except (ValueError, TypeError):
                    continue  # A concurrent final JSONL write may be incomplete.
                if (event.get('schemaVersion') == 'openclaw.diagnostics.v1'
                        and event.get('type') == 'mark' and event.get('name') == 'gateway.ready'
                        and event.get('phase') == 'startup'
                        and event.get('attributes', {}).get('traceName') == 'ready'
                        and event.get('pid') == expected and event.get('envName') == env_name
                        and timestamp >= since):
                    return {key: event.get(key) for key in
                            ['timestamp', 'pid', 'envName', 'runId', 'durationMs']}
        time.sleep(0.1)
    raise RuntimeError('missing final gateway.ready timeline mark for the warm PID')

def snapshot_before_destroy(arm, name, real, env):
    warm = json.loads((arm / 'receipts' / (name + '.json')).read_text())['warm']
    current = receipt(status(real, name, env), env)
    if (current['pid'], current['startTicks']) != (warm['pid'], warm['startTicks']):
        raise RuntimeError('snapshot target is not the verified warm gateway')
    directory = arm / 'snapshots'
    pid = warm['pid']
    started = time.time()
    (directory / f'{pid}.request').touch(exist_ok=False)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        done = list(directory.glob(f'{pid}.*.done.json'))
        if list(directory.glob(f'{pid}.*.error.json')):
            raise RuntimeError('in-process snapshot failed; inspect private receipt')
        completed = {p.name.replace('.done.json', '') for p in done}
        if f'{pid}.0' in completed:
            profiles = []
            sqlite_worker = False
            for marker in done:
                prefix = marker.name.removesuffix('.done.json')
                data = json.loads((directory / (prefix + '.cpuprofile')).read_text())
                thread = int(prefix.split('.')[1])
                if not data.get('samples') or len(data['samples']) != len(data.get('timeDeltas', [])):
                    raise RuntimeError('empty/inconsistent pre-exit snapshot')
                sqlite_worker |= thread > 0 and any('sqlite' in n.get('callFrame', {}).get('url', '').lower() for n in data['nodes'])
                profiles.append({'file': prefix + '.cpuprofile', 'threadId': thread, 'samples': len(data['samples']),
                                 'sha256': sha(directory / (prefix + '.cpuprofile'))})
            if sqlite_worker:
                current = receipt(status(real, name, env), env)
                if (current['pid'], current['startTicks']) != (warm['pid'], warm['startTicks']):
                    raise RuntimeError('warm gateway exited before snapshot confirmation')
                save(arm / 'snapshot-capture.json', {'qualification': False, 'warm': warm,
                     'requestedAt': started, 'confirmedAt': time.time(), 'profiles': profiles,
                     'scope': 'pre-teardown samples, not shutdown trace or comparable performance qualification'})
                return
        time.sleep(0.05)
    raise RuntimeError('main and SQLite worker snapshots not confirmed within 20 seconds')

def preserve_shutdown_logs(arm, name, env):
    warm = json.loads((arm / 'snapshot-capture.json').read_text())['warm']
    deadline = time.monotonic() + 5
    exited = False
    while time.monotonic() < deadline:
        try:
            ticks = Path(f"/proc/{warm['pid']}/stat").read_text().split(') ', 1)[1].split()[19]
        except FileNotFoundError:
            exited = True
            break
        if ticks != warm['startTicks']:
            exited = True
            break
        time.sleep(0.05)
    save(arm / 'shutdown-observation.json', {'warm': warm, 'exitConfirmed': exited, 'observedAt': time.time()})
    source = Path(env['OCM_HOME']) / 'supervisor' / 'logs'
    target = arm / 'logs' / 'post-shutdown'
    target.mkdir(exist_ok=True)
    for filename in ['daemon.stdout.log', 'daemon.stderr.log', name + '.stdout.log', name + '.stderr.log']:
        path = source / filename
        if path.is_file():
            # Bound copies; never print log or profile content.
            with path.open('rb') as stream:
                stream.seek(max(0, path.stat().st_size - 1024 * 1024))
                (target / filename).write_bytes(stream.read())
    if not exited:
        raise RuntimeError('warm process exit unconfirmed; logs retained after stop attempt')

def shim():
    env = dict(os.environ)
    real, arm = env['CAUSAL_OCM'], Path(env['CAUSAL_ARM'])
    args = sys.argv[1:]
    service = len(args) >= 3 and args[0] == 'service' and args[1] in ('install', 'start', 'restart')
    # ONLY this command wrapper adds profiler flags. Never profile npm, pnpm,
    # builds, the Kova controller, or unrelated OCM introspection commands.
    if service:
        env['NODE_OPTIONS'] = ('--require=' + str(arm / 'snapshot.cjs') if env.get('CAUSAL_SHUTDOWN_SNAPSHOT') == '1'
                               else '--cpu-prof --cpu-prof-dir=' + str(arm / 'profiles'))
    else:
        env.pop('NODE_OPTIONS', None)
    before = None
    restart_started = time.time()
    if service and args[1] == 'restart':
        before = receipt(status(real, args[2], env), env)
    if args[:2] == ['env', 'destroy'] and len(args) >= 3:
        # Without Kova OCM-diagnostics mode, this uninstall is the first stop.
        # Snapshot while the verified warm process is alive; keep teardown unchanged.
        snapshot = env.get('CAUSAL_SHUTDOWN_SNAPSHOT') == '1'
        if snapshot:
            snapshot_before_destroy(arm, args[2], real, env)
        try:
            subprocess.run([real, 'service', 'uninstall', args[2], '--json'], env=env, check=True, stdout=subprocess.DEVNULL)
        finally:
            if snapshot:
                preserve_shutdown_logs(arm, args[2], env)
    result = subprocess.run([real] + args, env=env)
    if result.returncode == 0 and service and args[1] == 'restart':
        after = receipt(status(real, args[2], env), env)
        if before['pid'] == after['pid'] and before['startTicks'] == after['startTicks']:
            raise RuntimeError('warm restart did not replace the gateway process')
        timeline = Path(env['OPENCLAW_DIAGNOSTICS_TIMELINE_PATH'])
        ready = warm_ready(timeline, after['pid'], args[2], restart_started)
        stable = receipt(status(real, args[2], env), env)
        if (stable['pid'], stable['startTicks']) != (after['pid'], after['startTicks']):
            raise RuntimeError('warm gateway changed between restart readiness and capture')
        record = {'envName': args[2], 'cold': before, 'warm': stable,
                  'restartStartedAt': restart_started, 'timelineReady': ready}
        # One file per sequential restart; no source output or credentials.
        save(arm / 'receipts' / (args[2] + '.json'), record)
    if result.returncode == 0 and args[:2] == ['runtime', 'build-local']:
        meta = json.loads(captured([real, 'runtime', 'show', args[2], '--json'], env))
        binary = Path(meta['binaryPath'])
        package = binary.parent
        info = json.loads((package / 'dist' / 'build-info.json').read_text())
        if info.get('commit') != env['CAUSAL_SHA']:
            raise RuntimeError('installed runtime build-info commit mismatch')
        save(arm / 'runtime-identity.json', {'commit': info['commit'], 'entrySha256': sha(binary)})
    return result.returncode

def validate_profiles(arm):
    records = [json.loads(p.read_text()) for p in sorted((arm / 'receipts').glob('*.json'))]
    if len(records) != 3:
        raise RuntimeError('expected three warm restart PID receipts')
    for record in records:
        ready = record.get('timelineReady', {})
        if ready.get('pid') != record['warm']['pid'] or ready.get('envName') != record['envName']:
            raise RuntimeError('missing matching warm timeline readiness receipt')
    warm_pids = {r['warm']['pid'] for r in records}
    inventory = []
    for p in sorted((arm / 'profiles').glob('*.cpuprofile')):
        match = re.fullmatch(r'CPU[.][0-9]{8}[.][0-9]{6}[.]([0-9]+)[.]([0-9]+)[.][0-9]+[.]cpuprofile', p.name)
        if not match:
            raise RuntimeError('unrecognized CPU profile filename')
        if int(match[1]) not in warm_pids:
            continue
        data = json.loads(p.read_text())
        if not data.get('samples') or len(data.get('samples', [])) != len(data.get('timeDeltas', [])):
            raise RuntimeError('empty/inconsistent CPU capture')
        frames = [n.get('callFrame', {}) for n in data['nodes']]
        # Keep only bounded frame metadata; original profile stays mode-0700 private.
        weights = dict()
        for sample, delta in zip(data['samples'], data['timeDeltas']):
            weights[sample] = weights.get(sample, 0) + delta
        top = []
        for node in data['nodes']:
            frame = node.get('callFrame', {})
            if not weights.get(node['id']):
                continue
            url = frame.get('url', '').split('?', 1)[0].split('#', 1)[0]
            # Basename only: never export home paths, source, queries, or content.
            top.append({'file': Path(url).name[:160],
                        'function': re.sub(r'[^a-zA-Z0-9_.$<> ():-]', '_', frame.get('functionName', ''))[:160],
                        'selfUs': weights[node['id']]})
        inventory.append({'file': p.name, 'pid': int(match[1]), 'threadId': int(match[2]),
                          'sha256': sha(p), 'samples': len(data['samples']),
                          'totalSampleUs': sum(data['timeDeltas']),
                          'sqliteWorker': any('sqlite' in f.get('url', '').lower() for f in frames),
                          'top': sorted(top, key=lambda x: -x['selfUs'])[:20]})
    for record in records:
        warm = [p for p in inventory if p['pid'] == record['warm']['pid']]
        if not any(p['threadId'] == 0 for p in warm):
            raise RuntimeError('missing warm-PID MAIN profile (cold/CLI capture is not evidence)')
        if not any(p['threadId'] > 0 and p['sqliteWorker'] for p in warm):
            raise RuntimeError('missing warm-PID SQLite WORKER capture')
    save(arm / 'profile-summary.json', {'qualification': False, 'warmReceipts': records, 'profiles': inventory})

def validate_status_observation(arm):
    reports = [json.loads(p.read_text()) for p in (arm / 'reports').glob('*.json')]
    reports = [r for r in reports if r.get('schemaVersion') == 'kova.report.v1']
    if len(reports) != 1 or len(reports[0]['records']) != 1:
        raise RuntimeError('status comparison requires one full report and one record')
    record = reports[0]['records'][0]
    if (record['scenario'], record['state']['id']) != ('fresh-install', 'fresh'):
        raise RuntimeError('status comparison record is not fresh-install/fresh')
    readiness = next(p for p in record['phases'] if p['id'] == 'readiness')['results']
    if len(readiness) != 1:
        raise RuntimeError('status comparison requires one readiness command')
    result = readiness[0]
    role = result['resourceSamples']['byRole']['status-cli']
    lower, upper = role['maxCpuPercentLower'], role['maxCpuPercent']
    if not isinstance(lower, (int, float)) or not isinstance(upper, (int, float)) or lower > upper:
        raise RuntimeError('missing status role CPU interval')
    raw = Path(record['collectorArtifactDirs']['resourceSamples']) / 'readiness-1.jsonl'
    samples = [json.loads(line) for line in raw.read_text().splitlines()]
    observed = set()
    valid = 0
    for sample in samples:
        if sample.get('collectionStatus') != 'ok':
            continue
        for proc in sample['processes']:
            if 'status-cli' not in proc.get('roles', []):
                continue
            required = ('pid', 'startTicks', 'cpuTicks', 'childCpuTicks', 'ownCpuPercentLower',
                        'ownCpuPercentUpper', 'reapedCpuPercentLower', 'reapedCpuPercentUpper', 'reapedProcesses')
            if not all(key in proc for key in required):
                raise RuntimeError('status raw process accounting is incomplete')
            observed.add((proc['pid'], proc['startTicks']))
            if isinstance(proc['ownCpuPercentUpper'], (int, float)):
                valid += 1
    if not valid:
        raise RuntimeError('no usable status raw CPU observations')
    save(arm / 'status-observation.json', {
        'qualification': False, 'status': record['status'], 'readinessMs': result['durationMs'],
        'roleCpuLower': lower, 'roleCpuUpper': upper, 'roleCpuWidth': upper - lower,
        'rawSamples': len(samples), 'observedStatusProcesses': len(observed),
        'rawFile': str(raw.relative_to(arm)), 'rawSha256': sha(raw),
        'scope': 'role interval and observed processes; not exact spawn counts or regression proof'})

def scenario_result(arm, plan, code, repeat=3):
    expected = {(e['scenario']['id'], e['state']['id'], iteration)
                for e in plan['entries'] for iteration in range(1, repeat + 1)}
    reports = []
    errors = []
    for path in (arm / 'reports').glob('*.json'):
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            errors.append('malformed Kova report JSON')
            continue
        if data.get('schemaVersion') == 'kova.report.v1':
            reports.append(data)
    records = []
    if len(reports) != 1:
        errors.append('expected one Kova full report')
    else:
        records = [{'scenario': r['scenario'], 'state': r['state']['id'],
                    'iteration': r['repeat']['index'], 'status': r['status']}
                   for r in reports[0]['records']]
    seen = {(r['scenario'], r['state'], r['iteration']) for r in records}
    missing = sorted(expected - seen)
    failed = [r for r in records if r['status'] != 'PASS']
    if missing:
        errors.append('selected records missing')
    if failed:
        errors.append('selected records not PASS')
    if seen - expected or len(seen) != len(records):
        errors.append('unexpected or duplicate records')
    if code != 0:
        errors.append('Kova exited nonzero')
    return {'kovaExit': code, 'scenarioValid': not errors, 'records': records,
            'missing': missing, 'failed': failed, 'errors': errors}

def cleanup():
    global ACTIVE
    if ACTIVE is None:
        return
    arm, env = ACTIVE
    # EXIT/INT/TERM trap: only this fresh, exclusive account/store's Kova envs.
    # Keep all evidence; never rm the store or force-destroy an unconfirmed process.
    failures = []
    real = env['CAUSAL_OCM']
    try:
        listing = json.loads(captured([real, 'env', 'list', '--json'], env))
        rows = listing if isinstance(listing, list) else listing.get('envs', listing.get('environments', []))
        for row in rows:
            name = row.get('name', row.get('envName', ''))
            if not name.startswith('kova-'):
                raise RuntimeError('unexpected environment in exclusive diagnostic store')
            logged([real, 'service', 'stop', name, '--json'], arm / 'logs' / 'cleanup.log', env)
            state = status(real, name, env)
            if state.get('running') or state.get('childPid'):
                raise RuntimeError('shutdown not confirmed; retaining environment')
            logged([real, 'service', 'uninstall', name, '--json'], arm / 'logs' / 'cleanup.log', env)
            logged([real, 'env', 'destroy', name, '--yes', '--json'], arm / 'logs' / 'cleanup.log', env)
    except Exception as error:
        failures.append(str(error))
    save(arm / 'cleanup.json', {'ok': not failures, 'errors': failures})
    ACTIVE = None
    if failures:
        raise RuntimeError('diagnostic cleanup incomplete; retained private evidence')

def stop_signal(number, _frame):
    raise SystemExit(128 + number)

def extract(archive, dest):
    with tarfile.open(archive) as tf:
        tf.extractall(dest, filter='data')

def run(options):
    global ACTIVE, BASE_ENV
    snapshot = getattr(options, 'shutdown_snapshot', False)
    status_comparison = getattr(options, 'status_comparison', False)
    if snapshot and status_comparison:
        raise RuntimeError('diagnostic modes are mutually exclusive')
    arms = ([(f'{index:02d}-{name}', commit) for index, (name, commit) in enumerate(ARMS * 5, 1)]
            if status_comparison else ARMS[:1] if snapshot else ARMS)
    filters = 'scenario:fresh-install' if status_comparison else 'scenario:bundled-plugin-startup' if snapshot else FILTERS
    exclude_args = ['--exclude', 'state:onboarded-user'] if status_comparison else []
    repeat = 1 if snapshot or status_comparison else 3
    root = options.root.resolve()
    if root.exists() or re.search(r'[^a-zA-Z0-9_./-]', str(root)):
        raise RuntimeError('root must be fresh, absolute, and contain no shell/Node-option metacharacters')
    # This is deliberate authorization for a DISPOSABLE executor account only.
    if options.exclusive_account != os.environ.get('USER') or options.exclusive_account in ('root', 'openclaw'):
        raise RuntimeError('must name the exclusive non-live executor account')
    home = Path.home()
    # sudo preserves the runner cwd, which this dedicated UID cannot traverse.
    os.chdir(home)
    if (home / '.ocm').exists() or (home / '.openclaw').exists():
        raise RuntimeError('refusing account with existing OCM or OpenClaw state')
    if os.uname().machine != 'x86_64' or len(os.sched_getaffinity(0)) < 4:
        raise RuntimeError('requires Linux x86_64 and at least four available CPUs')
    available_kib = int(re.search(r'MemAvailable: +([0-9]+)', Path('/proc/meminfo').read_text())[1])
    if available_kib < 12 * 1024 * 1024:
        raise RuntimeError('requires at least 12 GiB currently available RAM')
    captured(['systemctl', '--user', 'show-environment'])
    if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'ai.openclaw.ocm.service']).returncode == 0:
        raise RuntimeError('OCM service already active')
    if sha(options.node_archive) != NODE_SHA or sha(options.ocm_archive) != OCM_SHA:
        raise RuntimeError('archive checksum mismatch')
    os.umask(0o077)
    root.mkdir(parents=True)
    (root / 'toolchain').mkdir()
    extract(options.node_archive, root / 'toolchain')
    extract(options.ocm_archive, root / 'toolchain' / 'ocm')
    nodebin = root / 'toolchain' / 'node-v24.22.1-linux-x64' / 'bin'
    node = nodebin / 'node'
    ocm_candidates = list((root / 'toolchain' / 'ocm').rglob('ocm'))
    ocm_candidates = [p for p in ocm_candidates if p.is_file()]
    if len(ocm_candidates) != 1:
        raise RuntimeError('OCM archive layout mismatch')
    ocm = ocm_candidates[0]
    runtime = os.environ.get('XDG_RUNTIME_DIR', '')
    BASE_ENV = {'HOME': str(home), 'USER': options.exclusive_account, 'LOGNAME': options.exclusive_account,
                'PATH': str(nodebin) + ':/usr/bin:/bin', 'CI': '1',
                'XDG_RUNTIME_DIR': runtime, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus',
                'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
                'KOVA_SCENARIO_TIMEOUT_MS': '900000'}
    if captured([str(node), '--version'], BASE_ENV) != 'v24.22.1':
        raise RuntimeError('Node version mismatch')
    if '0.2.47' not in captured([str(ocm), '--version'], BASE_ENV):
        raise RuntimeError('OCM version mismatch')
    (root / 'tools').mkdir()
    logged([str(nodebin / 'npm'), 'install', '--prefix', str(root / 'tools'), 'pnpm@12.15.0',
            '--no-audit', '--no-fund'], root / 'toolchain.log', BASE_ENV)
    BASE_ENV['PATH'] = str(root / 'tools' / 'node_modules' / '.bin') + ':' + BASE_ENV['PATH']
    if captured(['pnpm', '--version'], BASE_ENV) != '12.15.0':
        raise RuntimeError('pnpm version mismatch')
    kova = root / 'kova'
    logged(['git', 'clone', '--no-hardlinks', '--no-checkout', str(options.kova_repo.resolve()), str(kova)], root / 'toolchain.log', BASE_ENV)
    logged(['git', '-C', str(kova), 'checkout', '--detach', KOVA], root / 'toolchain.log', BASE_ENV)
    if captured(['git', '-C', str(kova), 'rev-parse', 'HEAD'], BASE_ENV) != KOVA:
        raise RuntimeError('Kova identity mismatch')
    logged([str(nodebin / 'npm'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], root / 'toolchain.log', BASE_ENV, kova)
    save(root / 'identity.json', {'qualification': False, 'arms': arms, 'kova': KOVA,
                                'nodeArchiveSha256': NODE_SHA, 'ocmArchiveSha256': OCM_SHA,
                                'filter': filters, 'repeat': repeat, 'shutdownSnapshot': snapshot,
                                'statusComparison': status_comparison, 'host': os.uname().release,
                                'availableCpu': len(os.sched_getaffinity(0)),
                                'meminfo': Path('/proc/meminfo').read_text(),
                                'loadavg': Path('/proc/loadavg').read_text()})
    failures = []
    arm_results = {}
    for name, commit in arms:
        arm = root / name
        for directory in ['profiles', 'receipts', 'logs', 'reports', 'shim']:
            (arm / directory).mkdir(parents=True, exist_ok=True)
        (arm / 'shim' / 'ocm').symlink_to(Path(__file__).resolve())
        if snapshot:
            (arm / 'snapshots').mkdir()
            (arm / 'snapshot.cjs').write_text(SNAPSHOT_PRELOAD)
        env = dict(BASE_ENV, OCM_HOME=str(arm / 'ocm-home'), KOVA_HOME=str(arm / 'kova-home'),
                   CAUSAL_ARM=str(arm), CAUSAL_OCM=str(ocm), CAUSAL_NODE=str(node), CAUSAL_SHA=commit)
        env['PATH'] = str(arm / 'shim') + ':' + env['PATH']
        if snapshot:
            env['CAUSAL_SHUTDOWN_SNAPSHOT'] = '1'
        ACTIVE = (arm, env)
        if status_comparison:
            save(arm / 'placement.json', {'position': int(name[:2]), 'source': name[3:],
                 'commit': commit, 'loadavg': Path('/proc/loadavg').read_text(),
                 'meminfo': Path('/proc/meminfo').read_text()})
        source = arm / 'source'
        logged(['git', 'clone', '--no-hardlinks', '--no-checkout', str(options.openclaw_repo.resolve()), str(source)], arm / 'logs' / 'setup.log', env)
        logged(['git', '-C', str(source), 'checkout', '--detach', commit], arm / 'logs' / 'setup.log', env)
        if captured(['git', '-C', str(source), 'rev-parse', 'HEAD'], env) != commit or captured(['git', '-C', str(source), 'status', '--porcelain'], env):
            raise RuntimeError('frozen source identity/cleanliness mismatch')
        save(arm / 'source-identity.json', {'commit': commit, 'tree': captured(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}'], env)})
        logged(['pnpm', 'install', '--frozen-lockfile'], arm / 'logs' / 'setup.log', env, source)
        plan = json.loads(captured([str(node), str(kova / 'bin' / 'kova.mjs'), 'matrix', 'plan',
                                    '--profile', 'release', '--target', 'local-build:' + str(source),
                                    '--include', filters, *exclude_args, '--parallel', '1', '--repeat', str(repeat), '--json'], env, source))
        if plan.get('controls', {}).get('include') != filters.split(','):
            raise RuntimeError('Kova plan changed requested filters')
        if snapshot and [(e['scenario']['id'], e['state']['id']) for e in plan['entries']] != [('bundled-plugin-startup', 'fresh')]:
            raise RuntimeError('snapshot proof requires exactly one bundled/fresh plan entry')
        if status_comparison and (plan.get('controls', {}).get('exclude') != ['state:onboarded-user']
                or [(e['scenario']['id'], e['state']['id'], e.get('status')) for e in plan['entries']]
                != [('fresh-install', 'fresh', 'SELECTED')]):
            raise RuntimeError('status comparison requires exactly one selected fresh-install/fresh entry')
        save(arm / 'plan.json', plan)
        args = [str(node), str(kova / 'bin' / 'kova.mjs'), 'matrix', 'run', '--profile', 'release',
                '--target', 'local-build:' + str(source), '--include', filters, *exclude_args, '--auth', 'mock',
                '--parallel', '1', '--repeat', str(repeat), '--timeout-ms', '900000',
                '--report-dir', str(arm / 'reports'), '--execute', '--json']
        code = logged(args, arm / 'logs' / 'kova.log', env, source, allowed=True)
        arm_results[name] = scenario_result(arm, plan, code, repeat)
        save(arm / 'exit.json', {'qualification': False, **arm_results[name]})
        cleanup()
        try:
            if not (arm / 'runtime-identity.json').exists():
                raise RuntimeError('missing installed runtime source identity')
            if status_comparison:
                validate_status_observation(arm)
            elif snapshot:
                capture = json.loads((arm / 'snapshot-capture.json').read_text())
                if not capture['profiles']:
                    raise RuntimeError('missing confirmed pre-exit capture')
            else:
                validate_profiles(arm)
        except Exception as error:
            failures.append(name + ': ' + str(error))
    scenario_valid = all(result['scenarioValid'] for result in arm_results.values())
    save(root / 'result.json', {'qualification': False, 'captureValid': not failures,
                               'captureErrors': failures, 'scenarioValid': scenario_valid,
                               'arms': arm_results})
    if failures or not scenario_valid:
        raise RuntimeError('capture or selected scenarios failed; inspect result.json (no causal conclusion)')
    print('NONQUALIFICATION: captures valid and selected scenarios PASS; private evidence at ' + str(root))

def main():
    if Path(sys.argv[0]).name == 'ocm':
        return shim()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--shutdown-snapshot', action='store_true',
                        help='one b764 bundled warm restart; non-root pre-teardown Inspector snapshots')
    parser.add_argument('--status-comparison', action='store_true',
                        help='ten fresh-install/fresh records, ABAB serial, five per source; diagnosis only')
    parser.add_argument('--root', type=Path)
    parser.add_argument('--openclaw-repo', type=Path)
    parser.add_argument('--kova-repo', type=Path)
    parser.add_argument('--node-archive', type=Path)
    parser.add_argument('--ocm-archive', type=Path)
    parser.add_argument('--exclusive-account')
    options = parser.parse_args()
    if options.shutdown_snapshot and options.status_comparison:
        parser.error('diagnostic modes are mutually exclusive')
    if options.dry_run and options.status_comparison:
        print(json.dumps({'qualification': False,
            'placements': [(f'{index:02d}-{name}', commit) for index, (name, commit) in enumerate(ARMS * 5, 1)],
            'kova': KOVA, 'nodeArchiveSha256': NODE_SHA, 'ocmArchiveSha256': OCM_SHA,
            'filters': 'scenario:fresh-install', 'exclude': 'state:onboarded-user',
            'repeat': 1, 'parallel': 1, 'recordsPerSource': 5,
            'requiredCapture': 'installed source identity and status-role raw CPU intervals; no warm restart'}, indent=2))
        return 0
    if options.dry_run:
        print(json.dumps({'qualification': False, 'arms': ARMS[:1] if options.shutdown_snapshot else ARMS, 'kova': KOVA, 'node': '24.22.1',
                          'nodeArchiveSha256': NODE_SHA, 'ocmArchiveSha256': OCM_SHA,
                          'filters': 'scenario:bundled-plugin-startup' if options.shutdown_snapshot else FILTERS,
                          'repeat': 1 if options.shutdown_snapshot else 3, 'parallel': 1,
                          'shutdownSnapshot': options.shutdown_snapshot,
                          'profilerScope': 'OCM service install/start/restart wrapper only',
                          'requiredCapture': 'one live warm PID: main + SQLite worker pre-teardown' if options.shutdown_snapshot else 'all three warm PIDs: main + SQLite worker'}, indent=2))
        return 0
    if any(getattr(options, name) is None for name in ['root', 'openclaw_repo', 'kova_repo', 'node_archive', 'ocm_archive', 'exclusive_account']):
        parser.error('execution requires every path and --exclusive-account')
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    try:
        run(options)
    finally:
        # Unlike atexit, cleanup failure participates in the process exit status,
        # including failed setup and SIGINT/SIGTERM exception paths.
        cleanup()
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('NONQUALIFICATION BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
