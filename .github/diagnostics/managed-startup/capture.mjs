import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const put = (name, value) => fs.writeFileSync(path.join(c.output, name), JSON.stringify(value, null, 2)+'\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => fs.readFileSync(file, 'utf8');
const parseLines = file => read(file).trim().split('\n').filter(Boolean).map(JSON.parse);
const proc = pid => '/proc/' + pid;
function identity(pid) {
  const stat = read(proc(pid)+'/stat');
  return { pid, startTicks: Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]),
    exe: fs.realpathSync(proc(pid)+'/exe'), cgroup: read(proc(pid)+'/cgroup').trim() };
}
function assertListener(pid) {
  const owned = new Set(fs.readdirSync(proc(pid)+'/fd').flatMap(fd => {
    try { return [fs.readlinkSync(proc(pid)+'/fd/'+fd)]; } catch { return []; }
  }));
  const portHex = c.port.toString(16).toUpperCase().padStart(4, '0');
  const rows = ['tcp','tcp6'].flatMap(name => read(proc(pid)+'/net/'+name).trim().split('\n').slice(1));
  if (!rows.some(row => { const fields = row.trim().split(/\s+/);
    return fields[1].endsWith(':'+portHex) && fields[3] === '0A' && owned.has('socket:['+fields[9]+']'); })) {
    throw Error('health listener not owned by instrumented gateway PID');
  }
}
async function probe(route) {
  try { const r = await fetch('http://127.0.0.1:'+c.port+route, { signal: AbortSignal.timeout(800) });
    await r.body?.cancel(); return r.status; } catch { return 0; }
}
let launch, pinned, readyAt;
const osRows = [];
try {
  while (Date.now() < c.hardEndAt) {
    if (!launch && fs.existsSync(path.join(c.output,'launch.json'))) {
      launch = JSON.parse(read(path.join(c.output,'launch.json')));
      // The wrapper exec is asynchronous with this read. Wait for the pinned Node exe.
      if (fs.realpathSync(proc(launch.pid)+'/exe') !== fs.realpathSync(c.node)) { launch = undefined; await sleep(25); continue; }
      pinned = identity(launch.pid);
      if (!pinned.cgroup.includes(c.unit) || launch.uid !== process.getuid()) throw Error('service ownership mismatch');
      const argv = fs.readFileSync(proc(launch.pid)+'/cmdline').toString().split('\0').filter(Boolean);
      if (JSON.stringify(argv) !== JSON.stringify(launch.profiledArgv)) throw Error('effective Node argv mismatch');
      put('gateway-identity.json', { ...pinned, effectiveArgv: argv });
    }
    if (launch) {
      const now = identity(launch.pid);
      if (now.startTicks !== pinned.startTicks || now.exe !== pinned.exe) throw Error('gateway replaced during capture');
      const status = read(proc(launch.pid)+'/status');
      osRows.push({ at: Date.now(), pid: launch.pid,
        rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
        threads: Number(status.match(/^Threads:\s+(\d+)/m)?.[1] ?? 0) });
      if (!readyAt && await probe('/health') === 200) {
        assertListener(launch.pid);
        readyAt = Date.now();
        // Kova's OCM readiness anchors to /health, not /ready.
        put('ready.json', { readyAt, endAt: readyAt+5000, pid: launch.pid, startTicks: pinned.startTicks,
          criterion: 'GET /health HTTP 200, listener owned by pinned PID', readyStatus: await probe('/ready') });
      }
      if (readyAt && Date.now() >= readyAt+5250) break;
    }
    await sleep(100);
  }
  if (!readyAt) throw Error('no Kova-compatible readiness within 120 seconds');
  assertListener(launch.pid);
  const mainPid = Number(execFileSync('systemctl', ['--user','show',c.unit,'-p','MainPID','--value'], { encoding:'utf8' }).trim());
  if (mainPid !== launch.pid) throw Error('native service MainPID does not match gateway');
  const files = fs.readdirSync(c.output).filter(f => f.startsWith('thread-') && f.endsWith('.jsonl'));
  const rows = files.flatMap(f => parseLines(path.join(c.output,f)));
  if (rows.some(r => r.pid !== launch.pid)) throw Error('unexpected gateway process generation');
  const loaded = rows.filter(r => r.kind === 'loaded');
  if (!loaded.some(r => r.threadId === 0) || loaded.some(r => r.node !== 'v24.22.1')) throw Error('main preload or Node identity missing');
  const discovered = rows.filter(r => r.kind === 'worker-observed' && r.at <= readyAt+5000);
  for (const observed of discovered) {
    if (!loaded.some(r => r.threadId === observed.childThreadId)) throw Error('observed worker lacks preload '+observed.childThreadId);
  }
  const online = rows.filter(r => r.kind === 'worker-online' && r.at <= readyAt+5000);
  if (!online.length) throw Error('no worker coverage; cannot answer allocation question');
  const ids = [...new Set([0, ...online.map(r => r.childThreadId)])];
  const summary = ids.map(id => {
    if (!loaded.some(r => r.threadId === id)) throw Error('preload missing in worker '+id);
    const samples = rows.filter(r => r.kind === 'sample' && r.threadId === id && r.at >= readyAt && r.at <= readyAt+5000);
    const exited = rows.some(r => r.kind === 'worker-exit' && r.childThreadId === id && r.at < readyAt+5000);
    if (!exited && (!samples.length || samples.at(-1).at < readyAt+4750)) throw Error('incomplete 5 second coverage in thread '+id);
    const max = key => samples.length ? Math.max(...samples.map(r => r[key])) : null;
    return { threadId:id, samples:samples.length, exitedBeforeWindowEnd:exited,
      peakHeapUsed:max('heapUsed'), peakHeapTotal:max('heapTotal'), peakExternal:max('external'),
      peakArrayBuffers:max('arrayBuffers'), peakMallocedMemory:max('mallocedMemory'),
      firstSampleAt:samples[0]?.at ?? null, lastSampleAt:samples.at(-1)?.at ?? null,
      maxSampleGapMs:samples.length > 1 ? Math.max(...samples.slice(1).map((r,i) => r.at-samples[i].at)) : null };
  });
  put('summary.json', { status:'captured-not-qualified', candidate:c.candidate, node:'24.22.1', readyAt,
    endAt:readyAt+5000, requestedIntervalMs:100, nativeServiceMainPid:mainPid,
    workersObserved:ids.length-1,
    workersAtReady:online.filter(r => r.at <= readyAt && !rows.some(e => e.kind === 'worker-exit' && e.childThreadId === r.childThreadId && e.at <= readyAt)).length,
    threadStats:summary,
    startupThroughWindowPeakRssKiB:Math.max(...osRows.map(r => r.rssKiB)),
    postReadyPeakProcessRssKiB:Math.max(...osRows.filter(r => r.at >= readyAt && r.at <= readyAt+5000).map(r => r.rssKiB)),
    peakOsThreads:Math.max(...osRows.map(r => r.threads)),
    limits:['native systemd topology, not OCM supervisor reproduction',
      'external/arrayBuffers overlap; mallocedMemory is only V8 native tracking',
      'RSS includes native code/stacks/fragmentation/shared pages; no per-thread RSS attribution',
      'timers are best effort; no GC forced; peaks may fall between samples'] });
} catch (error) {
  put('blocker.json', { status:'incomplete', error:error.message });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(c.output,'process-samples.jsonl'), osRows.map(r => JSON.stringify(r)).join('\n')+'\n');
}
