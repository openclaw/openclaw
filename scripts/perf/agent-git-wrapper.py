"""Git-wrapper A/A and A/B overhead; base shim and prepared candidate launcher required.

Run inside a Linux container with --network none --pids-limit 64. Arguments:
  BASE_SHIM CANDIDATE_SHIM SCRATCH_DIR [ALLOCATION_PRELOAD]
The scratch directory must not exist. No production state is read.
Acceptance: no per-call wall overhead increase; report CPU, allocation requests,
and A/A spread separately. Allocation instrumentation is for single-threaded
shell/Git probes on glibc, excludes mmap, and must never supply timing evidence.
"""
import json
import os
from pathlib import Path
import resource
import shutil
import statistics
import subprocess
import sys
import time

base, candidate, scratch, *preload = sys.argv[1:]
root = Path(scratch).resolve()
root.mkdir()
rows = []
env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
           GIT_CONFIG_COUNT='2', GIT_CONFIG_KEY_0='gc.auto', GIT_CONFIG_VALUE_0='0',
           GIT_CONFIG_KEY_1='maintenance.auto', GIT_CONFIG_VALUE_1='false')
native = shutil.which('git')
assert native.startswith('/')
try:
    for arm, source in [('A', base), ('B', candidate)]:
        (root / arm).mkdir()
        shutil.copyfile(source, root / arm / 'git')
        (root / arm / 'git').chmod(0o755)
    workspace = root / 'workspace'
    workspace.mkdir()
    payload = b'synthetic workspace\n'.ljust(18000, b'x')
    for index in range(62000):
        directory = workspace / str(index // 1000)
        directory.mkdir(exist_ok=True)
        (directory / str(index)).write_bytes(payload)
    subprocess.run([native, 'init', '-q', str(workspace)], env=env, check=True)
    subprocess.run([native, '-C', str(workspace), '-c', 'user.name=Fixture', '-c',
                    'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty',
                    '-m', 'synthetic'], env=env, check=True)
    iterations = 100 if preload else 1000
    # Counted owner work: one shell and one Git per version/probe call, before and after.
    for command in ['--version', 'rev-parse --verify HEAD']:
        for control in [True, False]:
            for pair in range(5):
                for arm in (['A', 'B'] if pair % 2 == 0 else ['B', 'A']):
                    selected = 'A' if control else arm
                    run_env = dict(env, PATH=f'{root / selected}:{workspace}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
                    log = root / 'allocations.jsonl'
                    log.unlink(missing_ok=True)
                    if preload:
                        run_env.update(LD_PRELOAD=preload[0], OPENCLAW_ALLOC_LOG=str(log))
                    script = f'i=0; while [ "$i" -lt {iterations} ]; do git {command} >/dev/null || exit; i=$((i+1)); done'
                    cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
                    start = time.perf_counter()
                    subprocess.run(['/bin/sh', '-c', script], cwd=workspace, env=run_env, check=True)
                    elapsed = time.perf_counter() - start
                    end_cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
                    allocations = [json.loads(line) for line in log.read_text().splitlines()] if preload else []
                    rows.append(dict(command=command, control=control, pair=pair, arm=arm,
                                     wallMs=1000*elapsed/iterations,
                                     cpuMs=1000*(end_cpu.ru_utime+end_cpu.ru_stime-cpu.ru_utime-cpu.ru_stime)/iterations,
                                     allocationCalls=sum(r['calls'] for r in allocations)/iterations,
                                     requestedBytes=sum(r['bytes'] for r in allocations)/iterations,
                                     load=os.getloadavg()))
    summary = {}
    for command in ['--version', 'rev-parse --verify HEAD']:
        for control in [True, False]:
            for arm in ['A', 'B']:
                group = [r for r in rows if (r['command'], r['control'], r['arm']) == (command, control, arm)]
                summary[f'{command}/{"AA" if control else "AB"}/{arm}'] = {
                    metric: dict(median=statistics.median(v := sorted(r[metric] for r in group)),
                                 p95=v[-1], min=v[0])
                    for metric in ['wallMs', 'cpuMs', 'allocationCalls', 'requestedBytes']}
    print(json.dumps(dict(files=62000, payloadBytes=62000*18000, native=native,
                         iterations=iterations, allocationInstrumented=bool(preload),
                         summary=summary, rows=rows), indent=2))
finally:
    shutil.rmtree(root)
