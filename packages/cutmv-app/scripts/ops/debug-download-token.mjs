// Debug download token and access check
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Checking recent download tokens for corey@securitywiz.net...\n');

  const tokens = await pool.query(`
    SELECT
      token,
      session_id,
      r2_key,
      user_email,
      created_at,
      expires_at,
      accessed_at
    FROM download_tokens
    WHERE user_email = 'corey@securitywiz.net'
    ORDER BY created_at DESC
    LIMIT 5;
  `);

  console.log(`Found ${tokens.rows.length} download tokens:\n`);

  tokens.rows.forEach((token, i) => {
    console.log(`Token #${i + 1}:`);
    console.log(`  Token: ${token.token.substring(0, 20)}...`);
    console.log(`  Session: ${token.session_id}`);
    console.log(`  R2 Key: ${token.r2_key}`);
    console.log(`  User: ${token.user_email}`);
    console.log(`  Created: ${token.created_at}`);
    console.log(`  Expires: ${token.expires_at}`);
    console.log(`  Accessed: ${token.accessed_at || 'Never'}`);
    console.log('');
  });

  // Check background jobs
  console.log('📊 Checking recent background jobs...\n');

  const jobs = await pool.query(`
    SELECT
      id,
      session_id,
      status,
      r2_download_url,
      download_path,
      user_email,
      completed_at
    FROM background_jobs
    WHERE user_email = 'corey@securitywiz.net'
    AND status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 3;
  `);

  console.log(`Found ${jobs.rows.length} completed jobs:\n`);

  jobs.rows.forEach((job, i) => {
    console.log(`Job #${i + 1}:`);
    console.log(`  ID: ${job.id}`);
    console.log(`  Session: ${job.session_id}`);
    console.log(`  Status: ${job.status}`);
    console.log(`  Download Path: ${job.download_path || 'None'}`);
    console.log(`  R2 URL: ${job.r2_download_url ? job.r2_download_url.substring(0, 80) + '...' : 'None'}`);
    console.log('');
  });

  // Test the encoded email logic
  const userEmail = 'corey@securitywiz.net';
  const encodedEmail = Buffer.from(userEmail.split('@')[0]).toString('base64').replace(/=/g, '');
  const userPath = `user-${encodedEmail}`;

  console.log('🔐 User path encoding:');
  console.log(`  Email: ${userEmail}`);
  console.log(`  Encoded: ${encodedEmail}`);
  console.log(`  User Path: ${userPath}`);

} catch (error) {
  console.error('Error:', error);
} finally {
  await pool.end();
}
