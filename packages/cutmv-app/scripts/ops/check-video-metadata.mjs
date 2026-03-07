// Check if video metadata is being saved
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Checking recent video uploads for metadata...\n');

  const result = await pool.query(`
    SELECT
      id,
      original_name,
      video_title,
      artist_info,
      user_email,
      uploaded_at
    FROM videos
    ORDER BY uploaded_at DESC
    LIMIT 5;
  `);

  if (result.rows.length === 0) {
    console.log('❌ No videos found in database');
  } else {
    console.log(`Found ${result.rows.length} recent videos:\n`);
    result.rows.forEach((video, idx) => {
      console.log(`${idx + 1}. Video ID: ${video.id}`);
      console.log(`   Original Name: ${video.original_name}`);
      console.log(`   Video Title: ${video.video_title || '(not set)'}`);
      console.log(`   Artist Info: ${video.artist_info || '(not set)'}`);
      console.log(`   User: ${video.user_email}`);
      console.log(`   Uploaded: ${video.uploaded_at}`);
      console.log('');
    });
  }

} catch (error) {
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
