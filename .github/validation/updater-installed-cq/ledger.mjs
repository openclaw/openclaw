// Read-only observation of the installed updater's ordinary SQLite receipt.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const rows = db.prepare('SELECT run_id, created_at_ms, status, phase, reason, target_json, steps_json, verification_json FROM update_runs ORDER BY created_at_ms DESC LIMIT 2').all();
  console.log(JSON.stringify(rows.map(({target_json,steps_json,verification_json,...row}) => ({...row,
    target:JSON.parse(target_json),steps:JSON.parse(steps_json),verification:JSON.parse(verification_json)}))));
} finally { db.close(); }
