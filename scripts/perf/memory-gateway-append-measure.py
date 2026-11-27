import ctypes,json,os,re,shutil,secrets,select,signal,socket,sqlite3,struct,subprocess,sys,threading,time,urllib.error,urllib.request
from pathlib import Path
root=Path(sys.argv[1]).resolve();repo=Path(sys.argv[2]).resolve();kind=sys.argv[3]
assert kind in ('smoke','full','candidate')
assert root.name.startswith('gateway-current-200227.') and root.parent==Path('/tmp')
os.umask(0o077)
state=root/kind
state.mkdir(mode=0o700,exist_ok=True);state.chmod(0o700)
work=state/'workspace';work.mkdir(mode=0o700,exist_ok=True);work.chmod(0o700)
corpus=root/('corpus-small' if kind=='smoke' else 'corpus')
small=kind=='smoke';nfiles=3 if small else 101963; ndirs=1 if small else 7713
def filedir(i):
 d=i%ndirs
 return corpus/f'folder-{d%64:02d}'/f'doc-{d:05d}'
first=filedir(0); created=[first/'newly-created.md',*[first/f'appended-{i}.md' for i in range(1,5)]]
if not corpus.exists():
 for n in range(ndirs):filedir(n).mkdir(parents=True)
 for n in range(nfiles):
  (filedir(n)/f'page-{n//ndirs:03d}.md').write_text('initial lindenharbor search marker\n' if n==0 else f'observation page {n}\n')
def out(phase,**kw):print(json.dumps(dict(phase=phase,version=os.environ.get('MEMORY_FIXTURE_LABEL',kind),**kw)),flush=True)
with socket.socket() as sk:
 sk.bind(('127.0.0.1',0));port=sk.getsockname()[1]
token=secrets.token_hex(32)
config={'gateway':{'mode':'local','bind':'loopback','port':port,'auth':{'mode':'token'},'controlUi':{'enabled':False},'tailscale':{'mode':'off'}},'discovery':{'mdns':{'mode':'off'}},'cron':{'enabled':False},'browser':{'enabled':False},'update':{'checkOnStart':False},'agents':{'entries':{'main':{'workspace':str(work)}}},'memory':{'search':{'provider':'none','fallback':'none','sources':['memory'],'extraPaths':[str(corpus)],'store':{'vector':{'enabled':False}}}}}
cfg=state/'openclaw.json';cfg.write_text(json.dumps(config))
node=str(root/'node-v24.22.1-linux-x64/bin/node')
env={**os.environ,'CI':'1','HOME':str(root/'home'),'PATH':str(Path(node).parent)+':'+os.environ['PATH'],'OPENCLAW_STATE_DIR':str(state),'OPENCLAW_CONFIG_PATH':str(cfg),'OPENCLAW_GATEWAY_TOKEN':token,'OPENCLAW_GATEWAY_PORT':str(port),'OPENCLAW_DISABLE_BONJOUR':'1','NO_COLOR':'1'}
cli=[node,str(repo/'openclaw.mjs')]
def clean(value):return str(value).replace(token,'[fixture credential]')
def run(args,timeout):
 r=subprocess.run(cli+args,env=env,cwd=repo,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError(clean((r.stdout+' '+r.stderr)[-2200:]))
 return r
dbfile=state/'agents/main/agent/openclaw-agent.sqlite'
def fetch(sql,params=()):
 with sqlite3.connect('file:'+str(dbfile)+'?mode=ro',uri=True,timeout=1) as db:return db.execute(sql,params).fetchone()[0]
def rowcount():return fetch("select count(*) from memory_index_sources where source='memory'") if dbfile.exists() else 0
def added_count():
 paths=[os.path.relpath(f,work) for f in created]
 return fetch("select count(distinct path) from memory_index_chunks where source='memory' and path in (?,?,?,?,?) and text like ?",(*paths,'%foxglovepier%'))
def markindexed():return fetch("select exists(select 1 from memory_index_chunks where path=? and source='memory' and text like ?)",(os.path.relpath(created[0],work),'%foxglovepier%'))==1
assert not any(p.exists() for p in created),'stale additions in source corpus'
if rowcount()!=nfiles:
 start=time.monotonic();r=run(['memory','index','--agent','main','--force'],3600)
 assert rowcount()==nfiles,rowcount()
 out('initial-index',sources=rowcount(),wallSec=round(time.monotonic()-start,2),stdout=clean(r.stdout.strip()[-180:]))
else:out('reuse-verified-index',sources=rowcount())
if os.environ.get('MEMORY_FIXTURE_INDEX_ONLY') == '1':sys.exit(0)
def search(m):
 r=run(['gateway','call','memory.search','--params',json.dumps({'query':m,'agentId':'main','maxResults':8 if m=='foxglovepier' else 2,'minScore':0}),'--json','--timeout','600000'],640)
 hits=[x.get('path') for x in json.loads(r.stdout).get('results',[]) if m in x.get('snippet','').lower()]
 assert hits,'seed or appended search marker absent: '+m
 return hits
def tool_search():
 body={'tool':'memory_search','sessionKey':'agent:main:main','args':{'query':'lindenharbor','minScore':0,'maxResults':2}}
 req=urllib.request.Request(f'http://127.0.0.1:{port}/tools/invoke',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=600) as response:j=json.load(response)
 except urllib.error.HTTPError as e:raise RuntimeError(clean(e.read().decode()[:600]))
 result=json.dumps(j.get('result',{})).lower()
 assert j.get('ok') and 'lindenharbor' in result and 'page-000.md' in result,'resident tool did not find seed page'
 out('resident-search',hit='page-000.md')
def sample(pid):
 p=Path('/proc')/str(pid)
 def ticks(f):
  t=f.read_text();a=t[t.rindex(')')+2:].split();return int(a[11])+int(a[12])
 rss=int(next(x.split()[1] for x in (p/'status').read_text().splitlines() if x.startswith('VmRSS:')))
 return time.monotonic(),ticks(p/'task'/str(pid)/'stat'),ticks(p/'stat'),rss
def metric(name,a,b,peak):
 hz=os.sysconf('SC_CLK_TCK');out(name,wallSec=round(b[0]-a[0],2),mainCpuMs=round(1000*(b[1]-a[1])/hz),totalCpuMs=round(1000*(b[2]-a[2])/hz),rssKiB=b[3],peakRssKiB=peak)
def pause_until(t):
 while time.monotonic()<t:time.sleep(min(.5,t-time.monotonic()) if t>time.monotonic()+.001 else .001)
def regcount(pid):
 n=0
 for f in (Path('/proc')/str(pid)/'fdinfo').iterdir():
  try:n+=f.read_text().count('inotify wd:')
  except OSError:pass
 return n
def listener():
 s=subprocess.run(['ss','-ltnpH','sport = :'+str(port)],capture_output=True,text=True,check=True).stdout
 m=re.search(r'pid=(\d+)',s)
 return int(m.group(1)) if m else None
stop=threading.Event();unique=set();accesses=overflow=0;record=False;guard=threading.Lock();observer_error=[];tool_error=[]
def observer():
 global accesses,overflow
 try:
  lib=ctypes.CDLL(None,use_errno=True);fd=lib.inotify_init1(os.O_NONBLOCK);assert fd>=0
  try:
   dirs=[corpus]+[corpus/f'folder-{n:02d}' for n in range(min(64,ndirs))]+[filedir(n) for n in range(ndirs)]
   assert int(Path('/proc/sys/fs/inotify/max_user_watches').read_text())>=len(dirs)*3
   for d in dirs:assert lib.inotify_add_watch(fd,os.fsencode(d),0x01000000|1)>=0,ctypes.get_errno()
   out('read-observer-ready',directories=len(dirs))
   while not stop.is_set():
    if not select.select([fd],[],[],.15)[0]:continue
    buf=os.read(fd,1048576);p=0
    with guard:
     while p<len(buf):
      wd,mask,_,sz=struct.unpack_from('iIII',buf,p);f=buf[p+16:p+16+sz].rstrip(b'\0');p+=16+sz
      if not record:continue
      if mask&16384:overflow+=1;continue
      if mask&1 and not mask&0x40000000 and f.endswith(b'.md'):unique.add((wd,f));accesses+=1
  finally:os.close(fd)
 except Exception as e:observer_error.append(str(e))
if kind=='full' and not (root/'initial-state').exists():
 shutil.copytree(state,root/'initial-state',symlinks=True)
 out('fixture-checkpoint',sources=rowcount())
gwlog=state/'gateway.log'
p=None
try:
 with gwlog.open('w') as log:
  p=subprocess.Popen(cli+['gateway','run','--allow-unconfigured','--bind','loopback','--port',str(port)],cwd=repo,env=env,stdout=log,stderr=log,start_new_session=True)
  ready=False; deadline=time.monotonic()+240
  while time.monotonic()<deadline:
   if p.poll() is not None:raise RuntimeError('Gateway exited '+str(p.returncode)+' before readiness')
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/readyz',timeout=2) as r:
     if r.status==200:ready=True;break
   except (OSError,ValueError):pass
   time.sleep(1)
  assert ready,'Gateway readiness timeout'
  pid=listener();assert pid
  out('search-existing',hits=search('lindenharbor'),listeningPid=pid)
  t=time.monotonic();obs=threading.Thread(target=observer,daemon=True);obs.start()
  def warm():
   try:
    pause_until(t+(0 if small else 75));tool_search()
   except Exception as e:tool_error.append(clean(e))
  w=threading.Thread(target=warm,daemon=True);w.start()
  w.join(640);assert not w.is_alive() and not tool_error,tool_error
  with guard:record=True;unique.clear();accesses=overflow=0
  def quiet(earliest,limit):
   previous=sample(pid);stable=None;last=None;peak=previous[3];deadline=time.monotonic()+limit
   while time.monotonic()<deadline:
    time.sleep(.5);now=sample(pid);peak=max(peak,now[3])
    with guard:seen=accesses
    if last!=seen or now[0]<earliest or (now[2]-previous[2])/os.sysconf('SC_CLK_TCK')>.25*(now[0]-previous[0]):
     stable=None
    else:
     if stable is None:stable=now[0]
     if now[0]-stable>=20:return now,peak
    last=seen;previous=now
   raise RuntimeError('no 20-second quiet period within '+str(limit)+' s')
  since=sample(pid);b,peak=quiet(t+120,300);metric('warmup-through-quiet',since,b,peak)
  assert regcount(pid)>=7778
  with guard:
   out('settled-start',registrations=regcount(pid),distinctWarmMarkdownReads=len(unique),accessEvents=accesses,queueOverflows=overflow,observerError=observer_error)
   assert overflow==0 and not observer_error
   unique.clear();accesses=overflow=0
  a=sample(pid);peak=a[3]
  for i,f in enumerate(created):
   f.write_text(f'new searchable foxglovepier page {i}\n')
   end=time.monotonic()+6
   while time.monotonic()<end:
    peak=max(peak,sample(pid)[3]);time.sleep(.25)
  b=sample(pid);peak=max(peak,b[3]);metric('five-new-pages',a,b,peak)
  deadline=time.monotonic()+360
  while added_count()!=len(created) and time.monotonic()<deadline:
   peak=max(peak,sample(pid)[3]);time.sleep(.5)
  assert added_count()==5,'not all five pages indexed before search'
  b=sample(pid);peak=max(peak,b[3]);metric('five-pages-published',a,b,peak)
  with guard:out('before-next-search',indexed=added_count(),distinctMarkdownRead=len(unique),accessEvents=accesses,queueOverflows=overflow)
  hits=search('foxglovepier')
  assert {Path(p).name for p in hits}=={f.name for f in created},hits
  b=sample(pid);peak=max(peak,b[3]);metric('through-successful-search',a,b,peak)
  out('search-new',hits=sorted(hits),secondsFromFirstCreation=round(b[0]-a[0],2))
  b,tailpeak=quiet(time.monotonic(),300);peak=max(peak,tailpeak);metric('writes-through-settled-search',a,b,peak)
  with guard:
   out('settled-output',indexed=added_count(),distinctMarkdownRead=len(unique),accessEvents=accesses,queueOverflows=overflow,observerError=observer_error)
   assert overflow==0 and not observer_error
except Exception as e:
 out('failed',error=clean(e),gatewayLog=clean(gwlog.read_text(errors='replace')[-4900:]) if gwlog.exists() else '')
 raise
finally:
 stop.set()
 if p is not None and p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=30)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 for f in created:f.unlink(missing_ok=True)
