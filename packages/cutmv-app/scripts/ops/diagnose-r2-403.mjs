// Diagnose R2 403 error
import { config } from 'dotenv';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

config();

const r2Config = {
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  endpoint: process.env.R2_ENDPOINT,
  bucketName: process.env.R2_BUCKET_NAME,
};

console.log('🔍 R2 Configuration Check:\n');
console.log('Endpoint:', r2Config.endpoint);
console.log('Bucket:', r2Config.bucketName);
console.log('Access Key ID:', r2Config.accessKeyId?.substring(0, 10) + '...');
console.log('');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: r2Config.endpoint,
  credentials: {
    accessKeyId: r2Config.accessKeyId,
    secretAccessKey: r2Config.secretAccessKey,
  },
  forcePathStyle: true,
});

// Test with a known R2 key from the logs
const testKey = 'user-Y29yZXlA/uploads/1765690982494-l4u9djfj52s-trim_C7870374-2D91-459B-A5CB-54477A8AE2D7.MP4';

console.log(`📝 Testing with R2 key: ${testKey}\n`);

try {
  // Test 1: Check if object exists
  console.log('Test 1: Checking if object exists...');
  const headCommand = new HeadObjectCommand({
    Bucket: r2Config.bucketName,
    Key: testKey,
  });

  const headResult = await r2Client.send(headCommand);
  console.log('✅ Object exists! Size:', headResult.ContentLength, 'bytes');
  console.log('');

  // Test 2: Generate signed URL with short expiry
  console.log('Test 2: Generating signed URL (60s expiry)...');
  const getCommand = new GetObjectCommand({
    Bucket: r2Config.bucketName,
    Key: testKey,
  });

  const signedUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 60 });
  console.log('✅ Signed URL generated');
  console.log('URL:', signedUrl.substring(0, 150) + '...');
  console.log('');

  // Test 3: Try to access the signed URL
  console.log('Test 3: Testing signed URL access...');
  const response = await fetch(signedUrl, { method: 'HEAD' });

  console.log('Response Status:', response.status, response.statusText);
  console.log('Content-Length:', response.headers.get('content-length'));
  console.log('Content-Type:', response.headers.get('content-type'));

  if (response.ok) {
    console.log('\n✅ SUCCESS! R2 signed URLs are working correctly.');
    console.log('\nThe issue must be elsewhere (timing, different key, etc.)');
  } else {
    console.log('\n❌ FAILED! Signed URL returned 403');
    console.log('\nPossible causes:');
    console.log('1. R2 bucket CORS settings need to allow your domain');
    console.log('2. R2 access key permissions are insufficient');
    console.log('3. Signed URL format is incorrect for R2');

    // Try accessing without signature
    console.log('\nTest 4: Checking if bucket is public...');
    const publicUrl = `${r2Config.endpoint}/${r2Config.bucketName}/${testKey}`;
    const publicResponse = await fetch(publicUrl, { method: 'HEAD' });
    console.log('Public access:', publicResponse.status, publicResponse.statusText);
  }

} catch (error) {
  console.error('❌ Error during testing:', error.message);
  console.error('\nFull error:', error);
}
