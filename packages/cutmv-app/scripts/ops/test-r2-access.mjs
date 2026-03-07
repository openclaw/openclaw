// Test R2 access with a recent upload
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Testing R2 Access...\n');

  // Get a recent video upload
  const videos = await pool.query(`
    SELECT id, original_name, r2_key, r2_url, size, uploaded_at
    FROM videos
    WHERE user_email = 'corey@securitywiz.net'
    ORDER BY uploaded_at DESC
    LIMIT 1;
  `);

  if (videos.rows.length === 0) {
    console.log('❌ No videos found for testing');
    process.exit(1);
  }

  const video = videos.rows[0];
  console.log('📹 Testing with video:');
  console.log(`  ID: ${video.id}`);
  console.log(`  Name: ${video.original_name}`);
  console.log(`  R2 Key: ${video.r2_key}`);
  console.log(`  Size: ${Math.round(video.size / 1024 / 1024)}MB`);
  console.log('');

  // Import R2Storage to test signed URL generation
  const { R2Storage } = await import('./dist/index.js');

  console.log('🔗 Generating signed URL...');
  const signedUrl = await R2Storage.getSignedUrl(video.r2_key, 3600);
  console.log(`✅ Signed URL generated: ${signedUrl.substring(0, 100)}...`);

  console.log('\n🌐 Testing R2 access with HEAD request...');
  const response = await fetch(signedUrl, { method: 'HEAD' });

  console.log(`Status: ${response.status} ${response.statusText}`);
  console.log(`Content-Length: ${response.headers.get('content-length')} bytes`);
  console.log(`Content-Type: ${response.headers.get('content-type')}`);

  if (response.ok) {
    console.log('\n✅ R2 access is working! Video processing should now succeed.');
  } else {
    console.log('\n❌ R2 access failed. Check your environment variables in Railway.');
    console.log('Make sure CLOUDFLARE_ACCOUNT_ID and R2_PUBLIC_DOMAIN are set correctly.');
  }

} catch (error) {
  console.error('❌ Error testing R2:', error.message);
} finally {
  await pool.end();
}
