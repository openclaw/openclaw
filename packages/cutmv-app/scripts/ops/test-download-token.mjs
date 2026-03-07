// Test the download token from the URL
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const testToken = '09b9751bbc5d699bfa9fc4ce6165e9a7fc58805e1934e5aa45a6b88913341b44';

try {
  console.log(`🔍 Looking up download token: ${testToken}\n`);

  const result = await pool.query(`
    SELECT
      dt.token,
      dt.session_id,
      dt.filename,
      dt.user_email,
      dt.expires_at,
      dt.created_at,
      bj.status as job_status,
      bj.r2_download_url,
      bj.download_path
    FROM download_tokens dt
    LEFT JOIN background_jobs bj ON bj.session_id = dt.session_id
    WHERE dt.token = $1;
  `, [testToken]);

  if (result.rows.length === 0) {
    console.log('❌ Token not found in database');
  } else {
    const data = result.rows[0];
    console.log('✅ Token found:');
    console.log(`  Session ID: ${data.session_id}`);
    console.log(`  Filename (R2 key): ${data.filename}`);
    console.log(`  User Email: ${data.user_email}`);
    console.log(`  Created: ${data.created_at}`);
    console.log(`  Expires: ${data.expires_at}`);
    console.log(`  Expired: ${new Date(data.expires_at) < new Date() ? 'YES' : 'NO'}`);
    console.log(`  Job Status: ${data.job_status}`);
    console.log(`  Download Path: ${data.download_path}`);
    console.log('');

    // Test the encoding logic
    const userEmail = data.user_email;
    const emailPrefix = userEmail.split('@')[0];
    const encodedWithoutAt = Buffer.from(emailPrefix).toString('base64').replace(/=/g, '');
    const encodedWithAt = Buffer.from(emailPrefix + '@').toString('base64').replace(/=/g, '');

    console.log('🔐 Email encoding check:');
    console.log(`  Email: ${userEmail}`);
    console.log(`  Prefix: ${emailPrefix}`);
    console.log(`  Encoded (without @): user-${encodedWithoutAt}`);
    console.log(`  Encoded (with @): user-${encodedWithAt}`);
    console.log(`  R2 Key: ${data.filename}`);
    console.log(`  Contains user-${encodedWithoutAt}: ${data.filename.includes('user-' + encodedWithoutAt)}`);
    console.log(`  Contains user-${encodedWithAt}: ${data.filename.includes('user-' + encodedWithAt)}`);
    console.log(`  Contains exports/: ${data.filename.includes('exports/')}`);
  }

} catch (error) {
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
