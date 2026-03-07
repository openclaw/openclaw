import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const result = await pool.query(`
    SELECT id, original_name, video_title, artist_info
    FROM videos
    WHERE id = 23;
  `);

  if (result.rows.length === 0) {
    console.log('Video 23 not found');
  } else {
    const video = result.rows[0];
    console.log('Video 23:');
    console.log('  Original Name:', video.original_name);
    console.log('  Video Title:', video.video_title || '(null)');
    console.log('  Artist Info:', video.artist_info || '(null)');
  }
} catch (error) {
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
