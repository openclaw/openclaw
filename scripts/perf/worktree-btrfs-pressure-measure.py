#!/usr/bin/env python3
"""Synthetic btrfs deletion/admission experiment; never use production data.

Requires Linux, Python, Node 24+, git and btrfs-progs. Mount a new task-owned
64 GiB btrfs loop image at --root before prepare. Nothing mounts or unmounts here.
Prepare creates 62,000 tracked 18 KiB files and a physical 35 GiB SQLite database
with 5,000 sessions. Run makes two reflink copies and rewrites every third file:
20,667 distinct small-file extent owners per copy, unlike a large contiguous
artifact. The immutable seed remains. Preparation and setup sync are untimed.

python3 scripts/perf/worktree-btrfs-pressure-measure.py prepare   --source /frozen/source --root /mnt/fixture --output /evidence
python3 scripts/perf/worktree-btrfs-pressure-measure.py run --label aa1 --count 2   --source /frozen/source --root /mnt/fixture --output /evidence

Run aa1/aa2 with the same source, then five serial interleaved parent/candidate
pairs with distinct labels and pinned --source roots. Real 60-second spacing,
60-second tail, SQLite WAL synchronous=FULL, kernel samples every 50 ms. Report
p99/max SQLite commits, fresh observed btrfs commits (including missed counter
increments), child CPU, deletion wall, probe timings and A/A spread. Commit
sampling can miss commits; it is not a trace. Kernel lifetime max includes setup.
Acceptance: hidden expensive intervals defer; physical tails/CPU must not worsen
more than 20% beyond A/A variation. No incident-fix claim without reproduced tails.
This runs the real deletion worker and pressure probe, not the complete Gateway
or archival snapshot owner. Recovery correctness needs the service tests.
"""
import argparse, json, os, pathlib, resource, sqlite3, subprocess, threading, time
p = argparse.ArgumentParser()
p.add_argument('action', choices=['prepare', 'run'])
p.add_argument('--source', type=pathlib.Path, required=True, help='Pinned source checkout')
p.add_argument('--root', type=pathlib.Path, required=True, help='Task-owned mounted btrfs fixture')
p.add_argument('--output', type=pathlib.Path, required=True, help='Existing evidence directory')
p.add_argument('--label', default='a1')
p.add_argument('--count', type=int, default=2)
a = p.parse_args()
root = a.root.resolve()
seed = root / 'seed'
db = root / 'writer.sqlite'

def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout

def stats():
    return {k: int(v) for k, v in (line.split() for line in stats_path.read_text().splitlines())}

def settle():
    run('btrfs', 'filesystem', 'sync', str(root))
    run('btrfs', 'subvolume', 'sync', str(root))
    run('btrfs', 'filesystem', 'sync', str(root))
uuid = run('findmnt', '-n', '-o', 'UUID', '--target', str(root)).strip()
stats_path = pathlib.Path('/sys/fs/btrfs') / uuid / 'commit_stats'
if a.action == 'prepare':
    if db.exists() or seed.exists():
        raise RuntimeError('fixture already exists')
    run('btrfs', 'subvolume', 'create', str(seed))
    payload = os.urandom(18432)
    for n in range(62000):
        directory = seed / 'packages' / str(n // 100)
        if n % 100 == 0:
            directory.mkdir(parents=True)
        (directory / f'module-{n}.txt').write_bytes(str(n).encode().ljust(32, b' ') + payload[32:])
    run('git', '-C', str(seed), 'init', '-q', '-b', 'main')
    run('git', '-C', str(seed), 'add', 'packages')
    run('git', '-C', str(seed), '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic repository')
    print('repository ready', flush=True)
    con = sqlite3.connect(db)
    con.execute('PRAGMA journal_mode=OFF')
    con.execute('CREATE TABLE sessions(id INTEGER PRIMARY KEY, name TEXT)')
    con.executemany('INSERT INTO sessions VALUES(?,?)', ((i, f'synthetic-{i}') for i in range(5000)))
    con.execute('CREATE TABLE transcripts(id INTEGER PRIMARY KEY, session_id INTEGER, body BLOB)')
    blob = os.urandom(1024 * 1024)
    for n in range(35 * 1024):
        con.execute('INSERT INTO transcripts VALUES(?,?,?)', (n, n % 5000, blob))
        if n % 1024 == 0:
            con.commit()
            print(f'db {n // 1024} GiB', flush=True)
    con.commit()
    con.execute('CREATE TABLE events(id INTEGER PRIMARY KEY, session_id INTEGER, body BLOB)')
    con.commit()
    con.close()
    settle()
    print(json.dumps({'prepared': True, 'uuid': uuid, 'dbBytes': db.stat().st_size, 'files': 62000, 'fileBytes': 18432, 'stats': stats()}), flush=True)
    raise SystemExit()
trees = []
for i in range(a.count):
    tree = root / f'{a.label}-{i}'
    if tree.exists():
        raise RuntimeError('existing run fixture')
    run('btrfs', 'subvolume', 'snapshot', str(seed), str(tree))
    for n in range(0, 62000, 3):
        with (tree / 'packages' / str(n // 100) / f'module-{n}.txt').open('r+b') as f:
            f.write(os.urandom(4096))
    trees.append(tree)
settle()
time.sleep(10)
start = time.monotonic()
prior = stats()
stop = threading.Event()
commits = []
counters = []
errors = []

def writer():
    try:
        con = sqlite3.connect(db)
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('PRAGMA synchronous=FULL')
        while not stop.is_set():
            con.execute('INSERT INTO events(session_id,body) VALUES(?,?)', (len(commits) % 5000, b'x' * 512))
            t = time.monotonic()
            con.commit()
            dt = (time.monotonic() - t) * 1000
            commits.append([time.monotonic() - start, dt])
            stop.wait(0.01)
        con.close()
    except Exception as e:
        errors.append(str(e))

def sampler():
    while not stop.is_set():
        counters.append({'at': time.monotonic() - start, **stats(), 'psi': pathlib.Path('/proc/pressure/io').read_text() if pathlib.Path('/proc/pressure/io').exists() else None})
        stop.wait(0.05)
w = threading.Thread(target=writer)
s = threading.Thread(target=sampler)
w.start()
s.start()
time.sleep(10)
removals = []
gates = []
r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
probe_script = "\nimport readline from 'node:readline';\nimport { pathToFileURL } from 'node:url';\nimport { getHeapStatistics } from 'node:v8';\nconst { createHostIoPressureProbe } = await import(pathToFileURL(process.argv[1]));\nconst probe = createHostIoPressureProbe();\nfor await (const line of readline.createInterface({input:process.stdin})) {\n  const cpu=process.cpuUsage(), heap=getHeapStatistics().used_heap_size, start=performance.now();\n  const pressure=await probe();\n  console.log(JSON.stringify({pressure, wallMs:performance.now()-start,\n    cpu:process.cpuUsage(cpu),heapDelta:getHeapStatistics().used_heap_size-heap}));\n}\n"
gate = subprocess.Popen(['node', '--input-type=module', '-e', probe_script, str(a.source.resolve() / 'src/infra/host-io-pressure.ts')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def probe():
    gate.stdin.write('probe\n')
    gate.stdin.flush()
    decision = json.loads(gate.stdout.readline())
    gates.append({'at': time.monotonic() - start, **decision})
    return decision['pressure']
probe()
warmup = gates.pop()
try:
    next_at = time.monotonic()
    for tree in trees:
        time.sleep(max(0, next_at - time.monotonic()))
        while probe():
            print(json.dumps({'label': a.label, 'deferral': gates[-1]}), flush=True)
            if time.monotonic() - start > 1200:
                raise RuntimeError('experiment exceeded 20-minute observation cap')
            time.sleep(300)
        before = stats()
        t = time.monotonic()
        run('node', str(a.source.resolve() / 'src/agents/worktrees/retired-worktree-cleanup.worker.ts'), str(tree))
        body = (time.monotonic() - t) * 1000
        removals.append({'at': t - start, 'bodyMs': body, 'settledMs': (time.monotonic() - t) * 1000, 'before': before, 'after': stats()})
        print(json.dumps({'label': a.label, 'removal': removals[-1]}), flush=True)
        next_at = t + 60
    time.sleep(60)
finally:
    stop.set()
    w.join()
    s.join()
    gate.stdin.close()
    gate.wait()
r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
lat = sorted((x[1] for x in commits))
summary = {'label': a.label, 'source': str(a.source.resolve()), 'durationS': time.monotonic() - start, 'count': len(commits), 'p99Ms': lat[int((len(lat) - 1) * 0.99)], 'maxMs': max(lat), 'cpuS': r1.ru_utime + r1.ru_stime - r0.ru_utime - r0.ru_stime, 'childMaxRssKiB': r1.ru_maxrss, 'btrfsStart': prior, 'btrfsEnd': stats(), 'maxObservedLastCommitMs': max((x['last_commit_ms'] for x in counters if x['commits'] > prior['commits']), default=0), 'removals': removals, 'gates': gates, 'warmup': warmup, 'errors': errors}
(a.output / f'{a.label}.json').write_text(json.dumps({'summary': summary, 'commits': commits, 'counters': counters}))
print(json.dumps(summary), flush=True)
settle()
