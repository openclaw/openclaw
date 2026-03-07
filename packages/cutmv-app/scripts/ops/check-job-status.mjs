// Check background job status
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Checking recent background jobs...\n');

  const jobs = await pool.query(`
    SELECT
      bj.id,
      bj.session_id,
      bj.user_email,
      bj.status,
      bj.progress,
      bj.error_message,
      bj.created_at,
      bj.completed_at,
      bj.r2_download_url,
      v.original_name as video_name
    FROM background_jobs bj
    LEFT JOIN videos v ON v.id = bj.video_id
    WHERE bj.user_email = 'corey@securitywiz.net'
    ORDER BY bj.created_at DESC
    LIMIT 5;
  `);

  console.log(`Found ${jobs.rows.length} recent jobs:\n`);

  jobs.rows.forEach((job, i) => {
    console.log(`Job #${i + 1}:`);
    console.log(`  ID: ${job.id}`);
    console.log(`  Video: ${job.video_name}`);
    console.log(`  Status: ${job.status}`);
    console.log(`  Progress: ${job.progress}%`);
    console.log(`  Created: ${job.created_at}`);
    console.log(`  Completed: ${job.completed_at || 'Not yet'}`);
    console.log(`  Error: ${job.error_message || 'None'}`);
    console.log(`  Download URL: ${job.r2_download_url ? 'Available' : 'Not yet'}`);
    console.log('');
  });

  // Check email deliveries
  console.log('\n📧 Checking email deliveries...\n');

  const emails = await pool.query(`
    SELECT
      email_type,
      status,
      sent_at,
      delivered_at,
      error_message,
      message_id
    FROM email_deliveries
    WHERE user_email = 'corey@securitywiz.net'
    ORDER BY sent_at DESC
    LIMIT 10;
  `);

  console.log(`Found ${emails.rows.length} email deliveries:\n`);

  emails.rows.forEach((email, i) => {
    console.log(`Email #${i + 1}:`);
    console.log(`  Type: ${email.email_type}`);
    console.log(`  Status: ${email.status}`);
    console.log(`  Sent: ${email.sent_at}`);
    console.log(`  Delivered: ${email.delivered_at || 'Pending'}`);
    console.log(`  Error: ${email.error_message || 'None'}`);
    console.log(`  Message ID: ${email.message_id}`);
    console.log('');
  });

} catch (error) {
  console.error('Error:', error);
} finally {
  await pool.end();
}
