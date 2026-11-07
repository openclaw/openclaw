#!/usr/bin/env python3
"""NONQUALIFICATION: unprofiled fresh-install/fresh ABAB diagnostic.
Only a fresh disposable account, never the live OpenClaw account.
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
        ('a27b', 'a27b5ab63e3c4efc4b700f60ae468b0ce529f0cd')]

KOVA = '4b8b1681446b868a44193ed6e97253a6c8bcbbbf'

NODE_SHA = '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6'

OCM_SHA = '05e0bb598fe391c75fe7668e159d7eb09168b4298b5d8d0999786e79e97d0642'

FILTERS = 'scenario:fresh-install'

ACTIVE = None

BASE_ENV = None

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

def shim():
    env = dict(os.environ)
    # Fail closed if Kova or an executor unexpectedly requests instrumentation.
    if env.pop('NODE_OPTIONS', '') or env.get('KOVA_OCM_COMMAND_NODE_OPTIONS'):
        raise RuntimeError('unprofiled diagnostic refuses injected Node options')
    real, arm = env['CAUSAL_OCM'], Path(env['CAUSAL_ARM'])
    args = sys.argv[1:]
    if args[:2] == ['env', 'destroy'] and len(args) >= 3:
        subprocess.run([real, 'service', 'uninstall', args[2], '--json'],
                       env=env, check=True, stdout=subprocess.DEVNULL)
    result = subprocess.run([real] + args, env=env)
    if result.returncode == 0 and args[:2] == ['runtime', 'build-local']:
        meta = json.loads(captured([real, 'runtime', 'show', args[2], '--json'], env))
        binary = Path(meta['binaryPath'])
        info = json.loads((binary.parent / 'dist' / 'build-info.json').read_text())
        if info.get('commit') != env['CAUSAL_SHA']:
            raise RuntimeError('installed runtime build-info commit mismatch')
        save(arm / 'runtime-identity.json', {'commit': info['commit'], 'entrySha256': sha(binary)})
    return result.returncode

def validate_plan(plan):
    if (plan.get('controls', {}).get('include') != [FILTERS]
            or plan.get('controls', {}).get('exclude') != ['state:onboarded-user']
            or [(e['scenario']['id'], e['state']['id'], e.get('status')) for e in plan['entries']]
            != [('fresh-install', 'fresh', 'SELECTED')]):
        raise RuntimeError('requires exactly one selected fresh-install/fresh entry')

def validate_observation(arm):
    reports = [json.loads(p.read_text()) for p in (arm / 'reports').glob('*.json')]
    reports = [r for r in reports if r.get('schemaVersion') == 'kova.report.v1']
    if len(reports) != 1 or len(reports[0]['records']) != 1:
        raise RuntimeError('requires one full report and one record')
    record = reports[0]['records'][0]
    if (record['scenario'], record['state']['id']) != ('fresh-install', 'fresh'):
        raise RuntimeError('record scenario mismatch')
    profiling = record.get('profiling', {})
    if any(profiling.get(k) for k in ['nodeProfile', 'deepProfile', 'heapSnapshot',
                                     'diagnosticReport', 'affectsPerformanceMeasurements']):
        raise RuntimeError('Kova reports instrumentation')
    evidence_root = Path(record['collectorArtifactDirs']['root'])
    evidence_root.resolve().relative_to(arm.resolve())
    if record.get('targetRuntime', {}).get('nodeVersion') != 'v24.22.1':
        raise RuntimeError('observed runtime Node version mismatch')
    if record.get('thresholdPolicy', {}).get('roleThresholds', {}).get('gateway', {}).get('maxCpuPercent') != 345:
        raise RuntimeError('frozen gateway threshold mismatch')
    if any(p.suffix in ('.cpuprofile', '.heapprofile', '.heapsnapshot') for p in evidence_root.rglob('*')):
        raise RuntimeError('unexpected profiler artifact')
    raw_dir = Path(record['collectorArtifactDirs']['resourceSamples'])
    raw_dir.resolve().relative_to(arm.resolve())
    inventory, gateway, errors, birth_windows = [], [], [], []
    provision_phase = next((p for p in record['phases'] if p['id'] == 'provision'), {})
    if len(provision_phase.get('results', [])) != 2:
        errors.append('missing exact install/start provision commands')
    # Keep native intervals byte-for-byte. This index copies scalar counters;
    # it does not recompute, narrow, smooth, sum threads, or replace Kova bounds.
    for phase in record['phases']:
        for index, result in enumerate(phase.get('results', []), 1):
            summary = result.get('resourceSamples')
            if not summary:
                continue
            path = raw_dir / (phase['id'] + '-' + str(index) + '.jsonl')
            samples = [json.loads(line) for line in path.read_text().splitlines()]
            inventory.append({'phase': phase['id'], 'file': str(path.relative_to(arm)),
                              'sha256': sha(path), 'summary': summary})
            if phase['id'] == 'provision':
                if summary.get('cpuCoverageComplete') is not True:
                    errors.append('provision native CPU coverage incomplete')
                if not samples or not samples[-1].get('cpuTerminal'):
                    errors.append('provision terminal sample missing')
            if phase['id'] == 'provision' and samples:
                birth_windows.append((samples[0].get('cpuClock') or {}).get('discoveryTicks', float('inf')))
            for sample in samples:
                for proc in sample.get('processes', []):
                    if proc.get('pid') != sample.get('gatewayPid'):
                        continue
                    keys = ['pid', 'startTicks', 'cpuTicks', 'childCpuTicks',
                            'ownCpuPercentLower', 'ownCpuPercentUpper',
                            'cpuHistoryComplete', 'cpuIntervalComplete']
                    if not all(k in proc for k in keys):
                        errors.append('gateway own-process counters incomplete')
                        continue
                    gateway.append({**{k: proc[k] for k in keys}, 'phase': phase['id'],
                        'timestamp': sample['timestamp'], 'cpuClock': sample.get('cpuClock'),
                        'terminal': sample.get('cpuTerminal', False),
                        'lowerBoundOnly': sample.get('cpuLowerBoundOnly', False),
                        'rawFile': str(path.relative_to(arm))})
    provision = [p for p in gateway if p['phase'] == 'provision']
    if not provision:
        errors.append('missing provisioning gateway samples')
    identities = {(p['pid'], p['startTicks']) for p in gateway}
    if len(identities) != 1:
        errors.append('missing or replaced fresh gateway identity')
    # Require observed birth inside a provisioning sample window, not merely a
    # first PID read after readiness. Exact cumulative CPU includes all threads.
    born = any(p['startTicks'] >= first - 1
               and p['startTicks'] <= (p.get('cpuClock') or {}).get('ticks', -1)
               and p['cpuHistoryComplete'] and p['cpuIntervalComplete']
               for first in birth_windows for p in provision)
    if not born:
        errors.append('gateway birth bracket not observed; do not infer a zero baseline')
    terminal = [p for p in provision if p['terminal'] and not p['lowerBoundOnly']]
    if not terminal:
        errors.append('gateway provisioning settlement missing')
    timelines = list(evidence_root.rglob('timeline.jsonl'))
    marks = []
    for path in timelines:
        for line in path.read_text().splitlines():
            event = json.loads(line)
            if (event.get('schemaVersion') == 'openclaw.diagnostics.v1'
                    and event.get('phase') == 'startup' and event.get('type') == 'mark'):
                marks.append(event)
        inventory.append({'file': str(path.relative_to(arm)), 'sha256': sha(path)})
    ready = [m for m in marks if m.get('name') == 'gateway.ready'
             and m.get('attributes', {}).get('traceName') == 'ready'
             and m.get('envName') == record['envName']
             and any(m.get('pid') == pid for pid, _ in identities)]
    if ready and terminal:
        last_terminal = max(datetime.fromisoformat(p['timestamp'].replace('Z', '+00:00')).timestamp() for p in terminal)
        if not any(datetime.fromisoformat(m['timestamp'].replace('Z', '+00:00')).timestamp() <= last_terminal for m in ready):
            errors.append('no provisioning settlement after final ready')
    if not ready:
        errors.append('missing final startup-ready mark for sampled gateway')
    save(arm / 'observation.json', {'qualification': False, 'status': record['status'],
         'profiling': profiling, 'rawInventory': inventory, 'gatewayOwnProcess': gateway,
         'startupMarks': marks, 'captureErrors': sorted(set(errors)),
         'scope': 'process-own includes threads, excludes childCpuTicks; native role bounds remain unchanged; command terminal is not process exit'})
    if errors:
        raise RuntimeError('; '.join(sorted(set(errors))))

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
    arms = [(f'{index:02d}-{name}', commit) for index, (name, commit) in enumerate(ARMS * 5, 1)]
    filters = FILTERS
    exclude_args = ['--exclude', 'state:onboarded-user']
    repeat = 1
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
                                'filter': filters, 'repeat': repeat, 'unprofiled': True,
                                'thresholdPercent': 345, 'host': os.uname().release,
                                'availableCpu': len(os.sched_getaffinity(0)),
                                'meminfo': Path('/proc/meminfo').read_text(),
                                'loadavg': Path('/proc/loadavg').read_text()})
    failures = []
    arm_results = {}
    for name, commit in arms:
        arm = root / name
        for directory in ['logs', 'reports', 'shim']:
            (arm / directory).mkdir(parents=True, exist_ok=True)
        (arm / 'shim' / 'ocm').symlink_to(Path(__file__).resolve())
        env = dict(BASE_ENV, OCM_HOME=str(arm / 'ocm-home'), KOVA_HOME=str(arm / 'kova-home'),
                   CAUSAL_ARM=str(arm), CAUSAL_OCM=str(ocm), CAUSAL_NODE=str(node), CAUSAL_SHA=commit)
        env['PATH'] = str(arm / 'shim') + ':' + env['PATH']
        ACTIVE = (arm, env)
        save(arm / 'placement.json', {'position': int(name[:2]), 'source': name[3:],
             'commit': commit, 'host': os.uname().nodename,
             'affinity': sorted(os.sched_getaffinity(0)),
             'cpuinfo': Path('/proc/cpuinfo').read_text(),
             'loadavg': Path('/proc/loadavg').read_text(),
             'meminfo': Path('/proc/meminfo').read_text(),
             'cgroup': Path('/proc/self/cgroup').read_text(),
             'capturedAt': time.time()})
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
        validate_plan(plan)
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
            validate_observation(arm)
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
    parser.add_argument('--root', type=Path)
    parser.add_argument('--openclaw-repo', type=Path)
    parser.add_argument('--kova-repo', type=Path)
    parser.add_argument('--node-archive', type=Path)
    parser.add_argument('--ocm-archive', type=Path)
    parser.add_argument('--exclusive-account')
    options = parser.parse_args()
    if options.dry_run:
        print(json.dumps({'qualification': False, 'placements': [
            (f'{i:02d}-{name}', commit) for i, (name, commit) in enumerate(ARMS * 5, 1)],
            'kova': KOVA, 'node': '24.22.1', 'ocm': '0.2.47',
            'nodeArchiveSha256': NODE_SHA, 'ocmArchiveSha256': OCM_SHA,
            'filters': FILTERS, 'exclude': 'state:onboarded-user',
            'repeat': 1, 'parallel': 1, 'recordsPerSource': 5,
            'thresholdPercent': 345, 'unprofiled': True}, indent=2))
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

