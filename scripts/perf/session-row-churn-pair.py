#!/usr/bin/env python3
"""Run one already-prepared session-row churn pair under the shared Team guard."""
import argparse,fcntl,json,os,signal,subprocess,sys,time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--checkout',required=True,type=Path)
p.add_argument('--root',required=True,type=Path)
p.add_argument('--pair',required=True,type=int)
p.add_argument('--slot',choices=['a','b'],default='b')
p.add_argument('--lock-fd',type=int,help='Inherit campaign custody of the selected slot lock')
p.add_argument('--base-entry',required=True,type=Path)
p.add_argument('--fix-entry',required=True,type=Path)
p.add_argument('--retention',action='store_true')
a=p.parse_args(); a.checkout=a.checkout.resolve(); a.root=a.root.resolve()
assert str(a.root).startswith('/srv/perf-sandbox/') and a.root.parent != Path('/srv/perf-sandbox'), 'Use a dedicated task sandbox run directory'
assert a.pair>=1
for side in ['base','fix']: assert (a.root/side/'state/team-shape-summary.json').is_file()
ports={side:json.loads((a.root/side/'state/openclaw.json').read_text())['gateway']['port'] for side in ['base','fix']}
assert not any((a.root/side/'output').exists() for side in ['base','fix'])
guard='/srv/perf-sandbox/slot-b-guard.sh'
lock_path=Path('/srv/perf-sandbox/.quiet.lock' if a.slot=='a' else '/srv/perf-sandbox/.quiet-b.lock')
lock=lock_path.open('a') if a.lock_fd is None else os.fdopen(os.dup(a.lock_fd),'a')
held=os.fstat(lock.fileno()); expected=lock_path.stat()
assert (held.st_dev,held.st_ino)==(expected.st_dev,expected.st_ino),'Inherited descriptor must name the selected slot lock'
fcntl.flock(lock,fcntl.LOCK_EX)
subprocess.run([guard,'wait'],check=True)
start=96 if a.slot=='a' else 64
cpus=[','.join(str(c) for c in range(start+i,start+32,2)) for i in range(2)]
if a.pair%2==0: cpus.reverse()
units={side:f'session-row-churn-{os.getpid()}-{side}.scope' for side in ['base','fix']}
children={}; logs=[]; guard_proc=None; outside=None
prefix=a.root/'start'
meta={'pair':a.pair,'slot':a.slot,'startEpochMs':int(time.time()*1000),'cpus':dict(zip(['base','fix'],cpus)),'retention':a.retention,'ports':ports,'sync':[]}
def stop_signal(signum,frame): raise RuntimeError(f'pair interrupted by signal {signum}')
signal.signal(signal.SIGTERM,stop_signal);signal.signal(signal.SIGINT,stop_signal)
try:
 guard_log=(a.root/'guard.log').open('w'); logs.append(guard_log)
 guard_proc=subprocess.Popen([guard,'watch',str(os.getpid())],stdout=guard_log,stderr=subprocess.STDOUT)
 try:
  mp_log=(a.root/'outside-load.log').open('w');logs.append(mp_log)
  outside=subprocess.Popen(['mpstat','-P',','.join(str(c) for c in range(start,start+32)),'1'],stdout=mp_log,stderr=subprocess.STDOUT)
 except FileNotFoundError: meta['outsideLoad']='mpstat unavailable; /proc/loadavg at start/end only'
 meta['loadStart']=Path('/proc/loadavg').read_text().strip()
 for side in (['base','fix'] if a.pair%2 else ['fix','base']):
  entry=a.base_entry if side=='base' else a.fix_entry
  task_dir=a.root/side
  for d in ['home','tmp']: (task_dir/d).mkdir(exist_ok=True)
  log=(task_dir/'measure.log').open('w');logs.append(log)
  # Board widgets reserve Gateway port + 1 for the MCP App sandbox listener.
  cmd=['systemd-run','--scope','--quiet',f'--unit={units[side]}','-p',f'AllowedCPUs={meta["cpus"][side]}','-p','CPUWeight=10','-p','IOWeight=10','-p','MemoryMax=24G','nice','-n','10','ionice','-c3','env',f'HOME={task_dir}/home',f'OPENCLAW_HOME={task_dir}/home',f'TMPDIR={task_dir}/tmp','node','--enable-source-maps','--import','./scripts/tsx.mjs','scripts/perf/reconnect-read-wave-measure.ts','--root',str(task_dir/'state'),'--output',str(task_dir/'output'),'--entry',str(entry.resolve()),'--clients','65','--port',str(ports[side]),'--sync',str(prefix),'--side',side]
  if a.retention: cmd.append('--retention')
  # nice is additive: reset only this new launcher before requesting workload priority 10.
  children[side]=subprocess.Popen(cmd,cwd=a.checkout,stdout=log,stderr=subprocess.STDOUT,preexec_fn=lambda:os.setpriority(os.PRIO_PROCESS,0,0))
 for wave in range(5 if a.retention else 1):
  files=[Path(f'{prefix}.wave-{wave}.{side}.ready') for side in ['base','fix']]
  deadline=time.monotonic()+180
  while not all(f.is_file() for f in files):
   assert time.monotonic()<deadline,'pair startup/wave synchronization timed out'
   for side,proc in children.items(): assert proc.poll() is None,f'{side} exited before wave {wave} ready'
   time.sleep(.1)
  at=int(time.time()*1000)+2500
  go=Path(f'{prefix}.wave-{wave}.go')
  pending=go.with_name(go.name+'.tmp')
  pending.write_text(str(at))
  pending.replace(go)
  meta['sync'].append({'wave':wave,'startEpochMs':at,'ready':[json.loads(f.read_text()) for f in files]})
 for side,proc in children.items():
  code=proc.wait(timeout=240)
  assert code==0,f'{side} exited {code}; keep entire failed pair as setup evidence'
 meta['valid']=True
except BaseException as e:
 meta['valid']=False;meta['error']=str(e)
 raise
finally:
 # Only this invocation's scopes are touched, never production services.
 for side,proc in children.items():
  if proc.poll() is None:
   subprocess.run(['systemctl','kill','--kill-whom=all',units[side]],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   try:proc.wait(timeout=20)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
 for proc in [guard_proc,outside]:
  if proc and proc.poll() is None:proc.terminate();proc.wait()
 meta['endEpochMs']=int(time.time()*1000);meta['loadEnd']=Path('/proc/loadavg').read_text().strip()
 (a.root/'pair.json').write_text(json.dumps(meta,indent=2)+'\n')
 for log in logs:log.close()
