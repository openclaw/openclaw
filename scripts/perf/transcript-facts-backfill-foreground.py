"""Prepare equivalent disjoint cohorts inside the existing synthetic 10M DB.
No production schema or data. Run once before the foreground campaign.
The default prepares one 160-session cohort for identical fresh per-arm copies.
Use --cohorts N only for a sequential multi-arm run on disjoint cohorts.
python3 scripts/perf/transcript-facts-backfill-foreground.py \
  --fixture .local/facts/ten-million.sqlite --output .local/facts/preparation
"""
import argparse, json, os, sqlite3, time
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixture',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--cohorts',type=int,default=1)
args=parser.parse_args()
root=args.output.resolve()
filename=args.fixture.resolve()
local=Path.cwd()/'.local'
assert filename.is_relative_to(local) and root.is_relative_to(local)
assert filename.is_file() and not args.fixture.is_symlink()
assert 1<=args.cohorts<=15
fixture_report=filename.with_name(filename.stem+'-fixture.json')
report=json.loads(fixture_report.read_text())
assert report['rows']>=10_000_000 and report['name']==filename.stem
root.mkdir(parents=True,exist_ok=True)
label='foreground-prepare'
with (root/(label+'.pid')).open('x') as output: output.write(str(os.getpid()))
c=sqlite3.connect(filename)
c.execute('PRAGMA foreign_keys=ON')
c.execute('PRAGMA journal_mode=WAL')
start=time.monotonic()
counts=[]
for arm in range(args.cohorts):
    first=20000+arm*160
    for n in range(first,first+160):
        sid=f'synthetic-{n}'
        c.execute('DELETE FROM session_transcript_active_event_facts WHERE session_id=?',(sid,))
        c.execute('DELETE FROM session_transcript_active_events WHERE session_id=?',(sid,))
        c.execute('DELETE FROM transcript_event_identities WHERE session_id=?',(sid,))
        c.execute('DELETE FROM transcript_events WHERE session_id=?',(sid,))
        header=json.dumps(dict(type='session',version=3,id=sid,timestamp='2026-11-05T00:00:00.000Z',cwd='/synthetic'),separators=(',',':'))
        c.execute('INSERT INTO transcript_events(session_id,seq,event_json,created_at,event_utf8_bytes) VALUES(?,0,?,1,?)',(sid,header,len(header)))
        c.execute('INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,parent_id,created_at) VALUES(?,?,0,\'session\',NULL,1)',(sid,sid))
        for seq in range(1,601):
            eid=f'event-{seq-1}'
            parent=f'event-{seq-2}' if seq>1 else None
            message=dict(role='user' if seq%2 else 'assistant',content=[dict(type='text',text=f'synthetic message {seq-1:04d} '+('x'*512))],timestamp=1)
            if message['role']=='assistant':
                message.update(api='openai-responses',provider='openai',model='gpt-4.1',stopReason='stop',usage=dict(input=0,output=0,cacheRead=0,cacheWrite=0,totalTokens=0,cost=dict(input=0,output=0,cacheRead=0,cacheWrite=0,total=0)))
            event=dict(type='message',id=eid,parentId=parent,timestamp='2026-11-05T00:00:00.000Z',message=message)
            raw=json.dumps(event,separators=(',',':'))
            c.execute('INSERT INTO transcript_events(session_id,seq,event_json,created_at,event_utf8_bytes,navigation_type,navigation_display,message_role,navigation_last_type) VALUES(?,?,?,1,?,\'message\',1,?,\'message\')',(sid,seq,raw,len(raw),message['role']))
            c.execute('INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,parent_id,created_at) VALUES(?,?,?,\'message\',?,1)',(sid,eid,seq,parent))
            c.execute('INSERT INTO session_transcript_active_events VALUES(?,?,?,?,1)',(sid,seq-1,seq,seq-1))
        c.execute('UPDATE session_transcript_index_state SET indexed_seq=600,leaf_event_id=\'event-599\',needs_rebuild=0,active_event_count=600,active_message_count=600,updated_at=1 WHERE session_id=?',(sid,))
        c.execute('UPDATE transcript_rewrite_watermarks SET generation=\'foreground-generation\',updated_at=1 WHERE session_id=?',(sid,))
        c.execute('UPDATE session_windows SET transcript_updated_at=1,updated_at=1 WHERE session_id=?',(sid,))
        c.execute('UPDATE session_nodes SET entry_json=?,updated_at=1 WHERE current_session_id=?',(json.dumps(dict(sessionId=sid,updatedAt=1),separators=(',',':')),sid))
        c.commit()
    counts.append(dict(arm=arm,first=first,sessions=160,eventsEach=600,elapsedSeconds=time.monotonic()-start,load=os.getloadavg()))
    print(json.dumps(counts[-1]),flush=True)
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
result=dict(cohorts=counts,activeRows=c.execute('SELECT SUM(active_event_count) FROM session_transcript_index_state').fetchone()[0],fileBytes=filename.stat().st_size,elapsedSeconds=time.monotonic()-start)
(root/(label+'.json')).write_text(json.dumps(result,indent=2)+'\n')
c.close()
