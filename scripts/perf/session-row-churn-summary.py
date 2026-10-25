#!/usr/bin/env python3
import argparse,json,statistics
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);a=p.parse_args()
def read(p):return json.loads(p.read_text())
def quantile(v,q):return sorted(v)[max(0,__import__('math').ceil(len(v)*q)-1)] if v else None
def sample(root):
 r=read(root/'result.json');s=read(root/'wave-0-server.json');m=s['measurements']
 search=[x['ms'] for x in r['wireSamples'] if x['window'].startswith('wave-0:search-') and x['method']=='sessions.list']
 assert len(search)==195 and all(x['ok'] for x in r['wireSamples'])
 assert r['waveReports'][0]['submitted']==200 and r['waveReports'][0]['completed']==200
 tasks=m['tasks'];cons=[v for k,v in tasks.items() if k=='gateway:rpc:sessions.list:session-rows:consume'];roster=[v for k,v in tasks.items() if k=='gateway:rpc:sessions.list:agent-roster']
 assert cons,'Missing exact sessions.list consume scope; inspect raw labels instead of silently substituting'
 values={'searchP90Ms':quantile(search,.9),'searchCount':len(search),'searchFieldRebuilds':m['search']['repeatBuilds'],'searchInitialBuilds':m['search']['initialBuilds'],'mainCpuMs':sum(s['mainThreadCpu'].values())/1000,'consumeMs':sum(t['inclusiveMs'] for t in cons),'consumeCount':sum(t['calls'] for t in cons),'agentRosterTaskP90Ms':quantile([d for t in roster for d in t['durations']],.9),'agentRosterTaskCount':sum(t['calls'] for t in roster),'loopP95Ms':s['eventLoop']['p95Ms'],'loopP99Ms':s['eventLoop']['p99Ms'],'loopCount':s['eventLoop']['count'],'gcMs':s['gc']['totalMs'],'gcMsPerMinute':s['gc']['totalMs']*60000/s['elapsedMs'],'gcMaxMs':s['gc']['maxMs'],'gcCount':s['gc']['count'],'gcKinds':s['gc']['byKind'],'elapsedMs':s['elapsedMs']}
 return values
pairs=[]
for root in sorted(a.root.glob('pair-*'),key=lambda p:int(p.name.split('-')[-1])):
 metadata=read(root/'pair.json')
 if not metadata.get('valid'):continue
 base=sample(root/'base/output');fix=sample(root/'fix/output')
 pairs.append({'pair':root.name,'base':base,'fix':fix,'delta':{k:fix[k]-v for k,v in base.items() if isinstance(v,(float,int)) and isinstance(fix[k],(float,int))}})
summary={}
if pairs:
 for k,v in pairs[0]['base'].items():
  if not isinstance(v,(int,float)):continue
  b=[x['base'][k] for x in pairs];f=[x['fix'][k] for x in pairs];d=[y-x for x,y in zip(b,f)]
  summary[k]={'baseMean':statistics.mean(b),'fixMean':statistics.mean(f),'baseMedian':statistics.median(b),'fixMedian':statistics.median(f),'pairedMeanAbsoluteDelta':statistics.mean(d),'pairedMedianAbsoluteDelta':statistics.median(d),'pairedMeanRelativePercent':statistics.mean([(y-x)*100/x for x,y in zip(b,f) if x]) if any(b) else None,'absoluteMeanRelativePercent':statistics.mean(d)*100/statistics.mean(b) if statistics.mean(b) else None,'wins':sum(n<0 for n in d),'pairs':len(d)}
retention=[]
for root in sorted(a.root.glob('retention*')):
 for side in ['base','fix']:
  for file in sorted((root/side/'output').glob('wave-*-settled-retention.json')):
   r=read(file);retention.append({'run':root.name,'side':side,'wave':r['window'],'heapMiB':r['memory']['heapUsed']/1048576,'livePresentations':r['presentations']['aliveReturnedObjects'],'materialization':r['measurements']['materialization'],'familiesMiB':{k:v/1048576 for k,v in r['families'].items()}})
print(json.dumps({'pairs':pairs,'summary':summary,'retention':retention},indent=2))
