// Retry a failed background job
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Finding most recent failed job...\n');

  const failedJobs = await pool.query(`
    SELECT id, session_id, video_id, user_email, status, error_message
    FROM background_jobs
    WHERE status = 'failed'
    AND user_email = 'corey@securitywiz.net'
    ORDER BY created_at DESC
    LIMIT 1;
  `);

  if (failedJobs.rows.length === 0) {
    console.log('No failed jobs found');
    process.exit(0);
  }

  const job = failedJobs.rows[0];
  console.log('Found failed job:');
  console.log(`  ID: ${job.id}`);
  console.log(`  Session: ${job.session_id}`);
  console.log(`  Error: ${job.error_message}`);
  console.log('');

  console.log('🔄 Resetting job to pending status for retry...');

  await pool.query(`
    UPDATE background_jobs
    SET
      status = 'pending',
      progress = 0,
      error_message = NULL,
      started_at = NULL
    WHERE id = $1;
  `, [job.id]);

  console.log('✅ Job reset to pending. The background worker should pick it up automatically.');
  console.log(`\n📧 If processing succeeds, download email will be sent to: ${job.user_email}`);

} catch (error) {
  console.error('Error:', error);
} finally {
  await pool.end();
}
