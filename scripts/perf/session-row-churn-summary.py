#!/usr/bin/env python3
import argparse,json,statistics
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);a=p.parse_args()
def read(p):return json.loads(p.read_text())
def quantile(v,q):return sorted(v)[max(0,__import__('math').ceil(len(v)*q)-1)] if v else None
def sample(root):
 r=read(root/'result.json');s=read(root/'wave-0-server.json');m=s['measurements']
 search=[x['ms'] for x in r['wireSamples'] if x['window'].startswith('wave-0:search-') and x['method']=='sessions.list']
 lists=[x for x in r['wireSamples'] if x['window'].startswith('wave-0:') and x['method']=='sessions.list' and x['ok']]
 assert len(search)==195 and all(x['ok'] for x in r['wireSamples'])
 assert lists,'No completed sessions.list calls in the measured window'
 assert r['waveReports'][0]['submitted']==200 and r['waveReports'][0]['completed']==200
 tasks=m['tasks'];cons=[v for k,v in tasks.items() if k=='gateway:rpc:sessions.list:session-rows:consume'];roster=[v for k,v in tasks.items() if k=='gateway:rpc:sessions.list:agent-roster']
 assert cons,'Missing exact sessions.list consume scope; inspect raw labels instead of silently substituting'
 values={'searchP90Ms':quantile(search,.9),'searchCount':len(search),'searchFieldRebuilds':m['search']['repeatBuilds'],'searchInitialBuilds':m['search']['initialBuilds'],'mainCpuMs':sum(s['mainThreadCpu'].values())/1000,'consumeMs':sum(t['inclusiveMs'] for t in cons),'consumeCount':sum(t['calls'] for t in cons),'agentRosterTaskP90Ms':quantile([d for t in roster for d in t['durations']],.9),'agentRosterTaskCount':sum(t['calls'] for t in roster),'loopP95Ms':s['eventLoop']['p95Ms'],'loopP99Ms':s['eventLoop']['p99Ms'],'loopCount':s['eventLoop']['count'],'gcMs':s['gc']['totalMs'],'gcMsPerMinute':s['gc']['totalMs']*60000/s['elapsedMs'],'gcMaxMs':s['gc']['maxMs'],'gcCount':s['gc']['count'],'gcKinds':s['gc']['byKind'],'elapsedMs':s['elapsedMs']}
 values.update({'listCount':len(lists),'mainCpuMsPerList':values['mainCpuMs']/len(lists),'materializationWork':m.get('materializationWork')})
 work=m.get('materializationWork')
 if work is not None:
  for key in ['created','reused','rebuilt','skipped']:
   values['materialization'+key.title()]=work[key]
  repeated=work['reused']+work['rebuilt']+work['skipped']
  values.update({'materializationFullGraphComparisons':work['deepComparisons'],'materializationRepeated':repeated,'materializationEffectiveReusePercent':100*(work['reused']+work['skipped'])/repeated if repeated else None})
 return values
pairs=[]
for root in sorted(a.root.glob('pair-*'),key=lambda p:int(p.name.split('-')[-1])):
 metadata=read(root/'pair.json')
 if not metadata.get('valid'):continue
 base=sample(root/'base/output');fix=sample(root/'fix/output')
 assert (base['materializationWork'] is None)==(fix['materializationWork'] is None),'Pair materialization instrumentation differs'
 pairs.append({'pair':root.name,'base':base,'fix':fix,'delta':{k:fix[k]-v for k,v in base.items() if isinstance(v,(float,int)) and isinstance(fix[k],(float,int))}})
summary={}
if pairs:
 for k,v in pairs[0]['base'].items():
  if not isinstance(v,(int,float)):continue
  if any(not isinstance(pair[side].get(k),(int,float)) for pair in pairs for side in ['base','fix']):continue
  b=[x['base'][k] for x in pairs];f=[x['fix'][k] for x in pairs];d=[y-x for x,y in zip(b,f)]
  wins=sum(n>0 for n in d) if k=='materializationEffectiveReusePercent' else None if k in ['materializationCreated','materializationReused','materializationRebuilt','materializationSkipped','materializationRepeated','listCount'] else sum(n<0 for n in d)
  summary[k]={'baseMean':statistics.mean(b),'fixMean':statistics.mean(f),'baseMedian':statistics.median(b),'fixMedian':statistics.median(f),'pairedMeanAbsoluteDelta':statistics.mean(d),'pairedMedianAbsoluteDelta':statistics.median(d),'pairedMeanRelativePercent':statistics.mean([(y-x)*100/x for x,y in zip(b,f) if x]) if any(b) else None,'absoluteMeanRelativePercent':statistics.mean(d)*100/statistics.mean(b) if statistics.mean(b) else None,'wins':wins,'pairs':len(d)}
retention=[]
for root in sorted(a.root.glob('retention*')):
 for side in ['base','fix']:
  for file in sorted((root/side/'output').glob('wave-*-settled-retention.json')):
   r=read(file);retention.append({'run':root.name,'side':side,'wave':r['window'],'heapMiB':r['memory']['heapUsed']/1048576,'livePresentations':r['presentations']['aliveReturnedObjects'],'materialization':r['measurements']['materialization'],'familiesMiB':{k:v/1048576 for k,v in r['families'].items()}})
print(json.dumps({'pairs':pairs,'summary':summary,'retention':retention,'definitions':{'mainCpuMsPerList':'Total Gateway main-thread CPU for the mixed workload divided by completed sessions.list calls inside the measured wave, including cold lists and searches; excludes warmup and is not exclusive RPC CPU.','materializationFullGraphComparisons':'Production deepComparisons counter; excludes bounded field comparisons and sampled first-difference diagnostics.','materializationEffectiveReusePercent':'100 * (reused + skipped) / (reused + rebuilt + skipped); first creations excluded. Higher preserves more existing graphs.','materializationWork':'Raw outcome counters and sampled first differing source-field counts; null for older artifacts without these counters.','wins':'Lower cost is better for timing/work comparisons; higher effective reuse is better. Outcome/denominator counts have no win direction.'}},indent=2))
