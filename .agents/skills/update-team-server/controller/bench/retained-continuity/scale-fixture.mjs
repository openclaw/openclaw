// Synthetic scale only. Run in the disposable btrfs proof container before completion.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,statSync,existsSync,copyFileSync,constants} from 'node:fs';
import {join} from 'node:path';
export function scaleFixture(f) {
 const shared=new DatabaseSync(f.databasePath);
 shared.exec(`CREATE TABLE agent_deletion_journal (
   agent_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL DEFAULT '', phase TEXT,
   agent_dir TEXT NOT NULL, workspace_dir TEXT NOT NULL, sessions_dir TEXT NOT NULL,
   database_paths_json TEXT NOT NULL DEFAULT '[]', cleanup_paths_json TEXT NOT NULL DEFAULT '[]',
   created_at INTEGER NOT NULL, cleanup_completed INTEGER NOT NULL DEFAULT 0,
   delete_files INTEGER NOT NULL DEFAULT 1
 ) STRICT`);
 shared.close();
 const seeded=existsSync('/scale/template-agent.sqlite');
 if(seeded){const inode=statSync(f.agentDatabasePath).ino;copyFileSync('/scale/template-agent.sqlite',f.agentDatabasePath,constants.COPYFILE_FICLONE);if(statSync(f.agentDatabasePath).ino!==inode)throw Error('fixture clone replaced protected inode');}
 if(!seeded){
 const db=new DatabaseSync(f.agentDatabasePath);
 db.exec('BEGIN');
 const node=db.prepare('INSERT INTO session_nodes VALUES (?,?,?,?,NULL)'), window=db.prepare('INSERT INTO session_windows VALUES (?,?)'), watermark=db.prepare('INSERT INTO transcript_rewrite_watermarks VALUES (?,?)');
 for(let i=0;i<5999;i++) { const id='scale-session-'+i,key='agent:controller-test-agent:scale-'+i; node.run(key,id,JSON.stringify({sessionId:id,updatedAt:2}),2);window.run(id,key);watermark.run(id,'generation-'+i); }
 db.exec('COMMIT; CREATE TABLE synthetic_padding (payload BLOB)');
 const pad=db.prepare('INSERT INTO synthetic_padding VALUES (zeroblob(?))');
 for(let i=0;i<560;i++) pad.run(64*1024*1024);
 db.close();
 }
 const workspace=join(f.runtime,'workspace-shape');mkdirSync(workspace);
 const bytes=Buffer.alloc(17742,120);
 for(let i=0;i<62000;i++)writeFileSync(join(workspace,'synthetic-'+i),bytes);
 const shape={agentDbBytes:statSync(f.agentDatabasePath).size,agentDbAllocatedBytes:statSync(f.agentDatabasePath).blocks*512,sessions:6000,workspaceFiles:62000,workspaceBytes:62000*bytes.length,filesystem:'btrfs compress=zstd:1'};
 console.log('SHAPE',JSON.stringify(shape));return shape;
}
