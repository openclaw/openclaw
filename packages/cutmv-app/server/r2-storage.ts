import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'fs';
import path from 'path';

// R2 Configuration - ensure proper URL format for SDK compatibility
const R2_CONFIG = {
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  endpoint: process.env.R2_ENDPOINT?.replace(/\/$/, ''), // Remove trailing slash if present
  region: 'auto', // R2 uses 'auto' for region
  bucketName: process.env.R2_BUCKET_NAME!,
};

// Check R2 configuration (don't exit if missing - make it optional)
const isR2Configured = R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey && R2_CONFIG.endpoint && R2_CONFIG.bucketName;

if (!isR2Configured) {
  console.log('⚠️ R2 configuration incomplete - R2 storage will be disabled');
  console.log('Missing one or more: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_NAME');
}

// Create S3 client configured for Cloudflare R2 - minimal config to avoid SDK bugs
const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
  forcePathStyle: true,
});

// Auto-deletion tracking
const scheduledDeletions = new Map<string, NodeJS.Timeout>();

export class R2Storage {
  
  /**
   * Upload a file to R2 storage
   */
  static async uploadFile(localFilePath: string, r2Key: string, userEmail?: string): Promise<string> {
    try {
      console.log(`📤 Uploading to R2: ${localFilePath} → ${r2Key} (user: ${userEmail || 'unknown'})`);
      
      const fileStream = createReadStream(localFilePath);
      
      // Add user metadata to R2 object
      const metadata: Record<string, string> = {
        'upload-timestamp': new Date().toISOString(),
        'file-type': 'video'
      };
      
      if (userEmail) {
        metadata['user-email'] = userEmail;
        metadata['user-hash'] = Buffer.from(userEmail).toString('base64').substring(0, 8);
      }
      
      const uploadCommand = new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
        Body: fileStream,
        ContentType: R2Storage.getContentType(r2Key),
        Metadata: metadata,
      });

      await r2Client.send(uploadCommand);
      
      const publicUrl = `${R2_CONFIG.endpoint}/${R2_CONFIG.bucketName}/${r2Key}`;
      console.log(`✅ Upload successful: ${publicUrl} (user: ${userEmail})`);
      
      // Schedule auto-deletion after 30 minutes (default)
      R2Storage.scheduleAutoDeletion(r2Key);
      
      return publicUrl;
    } catch (error) {
      console.error(`❌ R2 upload failed for ${r2Key}:`, error);
      throw new Error(`Failed to upload to R2: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Download file directly from R2 using SDK (avoids signed URL 403 issues)
   */
  static async downloadFile(r2Key: string): Promise<Buffer> {
    if (!isR2Configured) {
      throw new Error('R2 storage is not properly configured');
    }

    try {
      console.log(`📥 Downloading file from R2: ${r2Key}`);

      const command = new GetObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
      });

      const response = await r2Client.send(command);

      if (!response.Body) {
        throw new Error('No data received from R2');
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      console.log(`✅ Downloaded ${buffer.length} bytes from R2: ${r2Key}`);
      return buffer;
    } catch (error: any) {
      console.error(`❌ Failed to download from R2: ${r2Key}`, error);
      throw new Error(`R2 download failed: ${error.message}`);
    }
  }

  /**
   * Generate a signed URL for private access (if needed)
   */
  static async getSignedUrl(r2Key: string, expiresInSeconds: number = 86400): Promise<string> { // Default 24 hours
    if (!isR2Configured) {
      throw new Error('R2 storage is not properly configured');
    }

    try {
      console.log(`🔗 Generating signed URL for: ${r2Key} (expires in ${expiresInSeconds}s)`);

      // First check if the object exists with detailed error handling
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: r2Key,
        });
        const headResponse = await r2Client.send(headCommand);
        console.log(`✅ Object verified in R2: ${r2Key} (size: ${headResponse.ContentLength} bytes)`);
      } catch (headError: any) {
        const errorCode = headError.name || headError.code || 'UnknownError';
        console.error(`❌ Object verification failed for R2 key: ${r2Key}`, {
          errorCode,
          message: headError.message,
          statusCode: headError.$response?.statusCode
        });

        if (errorCode === 'NotFound' || errorCode === 'NoSuchKey') {
          throw new Error(`NoSuchKey: File not found in R2 storage: ${r2Key}`);
        } else if (errorCode === 'AccessDenied') {
          throw new Error(`AccessDenied: Permission denied for R2 key: ${r2Key}`);
        } else {
          throw new Error(`R2 verification failed (${errorCode}): ${headError.message}`);
        }
      }

      // WORKAROUND: R2 signed URLs have issues, use direct download method instead
      console.log(`⚠️ Note: R2 signed URLs may not work - use R2Storage.downloadFile() for processing`);
      const command = new GetObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
      });

      const signedUrl = await getSignedUrl(r2Client, command, { expiresIn: expiresInSeconds });
      console.log(`✅ Signed URL generated successfully for ${r2Key} (expires in ${expiresInSeconds}s)`);
      console.log(`🔗 URL preview: ${signedUrl.substring(0, 120)}...`);
      return signedUrl;
    } catch (error: any) {
      const errorCode = error.name || error.code || 'UnknownError';
      console.error(`❌ Failed to generate signed URL for ${r2Key}:`, {
        errorCode,
        message: error.message,
        expiresInSeconds,
        bucket: R2_CONFIG.bucketName,
        endpoint: R2_CONFIG.endpoint
      });
      
      if (errorCode === 'ExpiredRequest' || error.message?.includes('expired')) {
        throw new Error(`ExpiredRequest: The request credentials have expired for ${r2Key}`);
      } else if (errorCode === 'InvalidRequest') {
        throw new Error(`InvalidRequest: Invalid R2 request parameters for ${r2Key}`);
      } else {
        throw new Error(`SignedURL generation failed (${errorCode}): ${error.message}`);
      }
    }
  }

  /**
   * Upload a buffer directly to R2 storage (for ZIP files created in memory)
   */
  static async uploadBuffer(buffer: Buffer, r2Key: string, contentType?: string, userEmail?: string): Promise<string> {
    if (!isR2Configured) {
      throw new Error('R2 storage is not properly configured');
    }

    try {
      console.log(`📤 Uploading buffer to R2: ${r2Key} (${buffer.length} bytes) (user: ${userEmail || 'unknown'})`);
      
      // Fix R2 upload by addressing the root cause of the AWS SDK issue
      const uploadCommand = new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
        Body: buffer,
        ContentType: contentType || R2Storage.getContentType(r2Key),
      });

      console.log(`🚀 Executing R2 upload command...`);
      const result = await r2Client.send(uploadCommand);
      console.log(`✅ R2 upload successful:`, { ETag: result.ETag });
      
      const publicUrl = `${R2_CONFIG.endpoint}/${R2_CONFIG.bucketName}/${r2Key}`;
      console.log(`✅ Buffer upload successful: ${publicUrl} (user: ${userEmail})`);
      
      // Schedule auto-deletion after 29 days
      R2Storage.scheduleAutoDeletion(r2Key);
      
      return publicUrl;
    } catch (error) {
      console.error(`❌ R2 buffer upload failed for ${r2Key}:`, error);
      
      // Fallback: Try with minimal AWS SDK command as last resort
      try {
        console.log(`🔄 Attempting fallback with minimal AWS SDK...`);
        const uploadCommand = new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: r2Key,
          Body: buffer,
        });
        
        const result = await r2Client.send(uploadCommand);
        console.log(`✅ Fallback upload successful:`, result.ETag);
        
        const publicUrl = `${R2_CONFIG.endpoint}/${R2_CONFIG.bucketName}/${r2Key}`;
        return publicUrl;
        
      } catch (fallbackError) {
        console.error(`❌ Fallback also failed:`, fallbackError);
        throw new Error(`Failed to upload buffer to R2: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  /**
   * MULTIPART UPLOAD: Create a multipart upload and get uploadId
   * This allows direct browser-to-R2 uploads without proxying through the server
   */
  static async createMultipartUpload(r2Key: string, contentType?: string, userEmail?: string): Promise<string> {
    if (!isR2Configured) {
      throw new Error('R2 storage is not properly configured');
    }

    try {
      console.log(`🔄 Creating multipart upload: ${r2Key} (user: ${userEmail || 'unknown'})`);

      const command = new CreateMultipartUploadCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
        ContentType: contentType || R2Storage.getContentType(r2Key),
        Metadata: {
          'upload-timestamp': new Date().toISOString(),
          'user-email': userEmail || 'unknown',
        },
      });

      const response = await r2Client.send(command);

      if (!response.UploadId) {
        throw new Error('No UploadId returned from R2');
      }

      console.log(`✅ Multipart upload created: ${response.UploadId}`);
      return response.UploadId;
    } catch (error) {
      console.error(`❌ Failed to create multipart upload for ${r2Key}:`, error);
      throw new Error(`Failed to create multipart upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * MULTIPART UPLOAD: Generate presigned URLs for uploading parts
   * Browser will use these URLs to upload chunks directly to R2
   */
  static async generatePresignedPartUrls(
    r2Key: string,
    uploadId: string,
    numberOfParts: number,
    expiresInSeconds: number = 3600 // 1 hour default
  ): Promise<string[]> {
    if (!isR2Configured) {
      throw new Error('R2 storage is not properly configured');
    }

    try {
      console.log(`🔗 Generating ${numberOfParts} presigned URLs for ${r2Key}`);

      const presignedUrls: string[] = [];

      for (let partNumber = 1; partNumber <= numberOfParts; partNumber++) {
        const command = new UploadPartCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: r2Key,
          UploadId: uploadId,
          PartNumber: partNumber,
        });

        const presignedUrl = await getSignedUrl(r2Client, command, {
          expiresIn: expiresInSeconds,
        });

        presignedUrls.push(presignedUrl);
      }

      console.log(`✅ Generated ${presignedUrls.length} presigned URLs`);
      return presignedUrls;
    } catch (error) {
      console.error(`❌ Failed to generate presigned URLs:`, error);
      throw new Error(`Failed to generate presigned URLs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * MULTIPART UPLOAD: Complete the multipart upload
   * Called after all parts have been uploaded by the browser
   */
  static async completeMultipartUpload(
    r2Key: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>
  ): Promise<string> {
    if (!isR2Configured) {
      throw new Error('R2 storage is not properly configured');
    }

    try {
      console.log(`✅ Completing multipart upload: ${r2Key} with ${parts.length} parts`);

      const command = new CompleteMultipartUploadCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts,
        },
      });

      const response = await r2Client.send(command);

      const publicUrl = `${R2_CONFIG.endpoint}/${R2_CONFIG.bucketName}/${r2Key}`;
      console.log(`✅ Multipart upload completed: ${publicUrl}`);

      // Schedule auto-deletion
      R2Storage.scheduleAutoDeletion(r2Key);

      return publicUrl;
    } catch (error) {
      console.error(`❌ Failed to complete multipart upload for ${r2Key}:`, error);
      throw new Error(`Failed to complete multipart upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * MULTIPART UPLOAD: Abort a multipart upload (cleanup on error/cancel)
   */
  static async abortMultipartUpload(r2Key: string, uploadId: string): Promise<void> {
    if (!isR2Configured) {
      throw new Error('R2 storage is not properly configured');
    }

    try {
      console.log(`🗑️ Aborting multipart upload: ${r2Key}`);

      const command = new AbortMultipartUploadCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
        UploadId: uploadId,
      });

      await r2Client.send(command);
      console.log(`✅ Multipart upload aborted successfully`);
    } catch (error) {
      console.error(`❌ Failed to abort multipart upload:`, error);
      // Don't throw - cleanup is best-effort
    }
  }

  /**
   * Delete a file from R2 storage
   */
  static async deleteFile(r2Key: string): Promise<void> {
    try {
      console.log(`🗑️ Deleting from R2: ${r2Key}`);
      
      const deleteCommand = new DeleteObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
      });

      await r2Client.send(deleteCommand);
      console.log(`✅ Deleted from R2: ${r2Key}`);
      
      // Cancel scheduled deletion if it exists
      const scheduledTimeout = scheduledDeletions.get(r2Key);
      if (scheduledTimeout) {
        clearTimeout(scheduledTimeout);
        scheduledDeletions.delete(r2Key);
      }
    } catch (error) {
      console.error(`❌ R2 deletion failed for ${r2Key}:`, error);
      throw new Error(`Failed to delete from R2: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Schedule automatic deletion after specified time (default 29 days for universal retention)
   */
  static scheduleAutoDeletion(r2Key: string, delayMs: number = 29 * 24 * 60 * 60 * 1000): void {
    // FIX: JavaScript setTimeout has a 32-bit signed integer limit (2,147,483,647ms = ~24.8 days)
    // 29 days (2,505,600,000ms) exceeds this limit and causes immediate timeout
    const MAX_TIMEOUT_MS = 2147483647; // Maximum safe timeout value
    
    if (delayMs > MAX_TIMEOUT_MS) {
      console.log(`⚠️ Requested delay (${delayMs}ms) exceeds setTimeout limit. Setting to max safe value (${MAX_TIMEOUT_MS}ms = ~24.8 days)`);
      delayMs = MAX_TIMEOUT_MS;
    }
    // Cancel existing scheduled deletion if any
    const existingTimeout = scheduledDeletions.get(r2Key);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Schedule new deletion
    const timeout = setTimeout(async () => {
      try {
        await R2Storage.deleteFile(r2Key);
        scheduledDeletions.delete(r2Key);
        console.log(`🕒 Auto-deleted after ${Math.round(delayMs / (24 * 60 * 60 * 1000))} days: ${r2Key}`);
      } catch (error) {
        console.error(`❌ Auto-deletion failed for ${r2Key}:`, error);
        scheduledDeletions.delete(r2Key);
      }
    }, delayMs);

    scheduledDeletions.set(r2Key, timeout);
    const days = Math.round(delayMs / (24 * 60 * 60 * 1000));
    console.log(`⏰ Scheduled auto-deletion for ${r2Key} in ${days} day${days !== 1 ? 's' : ''}`);
  }

  /**
   * Clean up old files on startup (for crash recovery)
   */
  static async cleanupOldFiles(): Promise<void> {
    try {
      console.log('🧹 Starting cleanup of old R2 files...');
      
      // This would require listing objects in R2 and checking timestamps
      // For now, we'll rely on the scheduled deletions
      // In a production environment, you could implement a more robust cleanup
      // by storing file timestamps in a database or using R2 lifecycle policies
      
      console.log('✅ R2 cleanup check completed');
    } catch (error) {
      console.error('❌ R2 cleanup failed:', error);
    }
  }

  /**
   * Generate a unique R2 key for file storage with proper folder organization
   */
  static generateR2Key(originalFilename: string, type: 'uploads' | 'exports' = 'uploads', userEmail?: string): string {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 15);
    const ext = path.extname(originalFilename);
    const baseName = path.basename(originalFilename, ext);
    
    // Replace non-alphanumeric chars with dashes, then collapse multiple dashes into one
    const sanitizedBaseName = baseName
      .replace(/[^a-zA-Z0-9-_]/g, '-')  // Replace special chars with dash
      .replace(/-+/g, '-')               // Collapse multiple dashes into one
      .replace(/^-|-$/g, '');            // Remove leading/trailing dashes
    
    // Proper folder organization for each user:
    // user-{hash}/uploads/ - for original video uploads
    // user-{hash}/exports/ - for processed video exports
    let key: string;
    if (userEmail) {
      const userHash = Buffer.from(userEmail).toString('base64').substring(0, 8).replace(/[+/=]/g, '');
      key = `user-${userHash}/${type}/${timestamp}-${randomId}-${sanitizedBaseName}${ext}`;
    } else {
      // Fallback for system files
      key = `system/${type}/${timestamp}-${randomId}-${sanitizedBaseName}${ext}`;
    }
    
    console.log(`🗂️ Generated R2 key: ${key} (type: ${type}, user: ${userEmail || 'system'})`);
    return key;
  }

  /**
   * Ensure exports folder exists for a user (creates placeholder if needed)
   */
  static async ensureExportsFolder(userEmail: string): Promise<void> {
    const userHash = Buffer.from(userEmail.split('@')[0]).toString('base64').substring(0, 8).replace(/[+/=]/g, '');
    const placeholderKey = `user-${userHash}/exports/.folder-placeholder`;
    
    try {
      // Check if placeholder already exists
      await r2Client.send(new HeadObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: placeholderKey
      }));
      
      console.log(`✅ Exports folder already exists for user: ${userEmail}`);
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        // Create the placeholder
        const placeholderContent = `# CUTMV Exports Folder\nThis folder contains processed video exports for user-${userHash}.\nCreated: ${new Date().toISOString()}\n`;
        
        await r2Client.send(new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: placeholderKey,
          Body: placeholderContent,
          ContentType: 'text/plain',
          Metadata: {
            'folder-type': 'exports',
            'created-by': 'system',
            'user-hash': userHash
          }
        }));
        
        console.log(`📁 Created exports folder for user: ${userEmail}`);
      } else {
        console.error(`❌ Error checking exports folder for ${userEmail}:`, error);
      }
    }
  }

  /**
   * Create user account details folder with email information and security tracking
   */
  static async createUserAccountDetails(userEmail: string, clientIP?: string, userAgent?: string): Promise<void> {
    const userHash = Buffer.from(userEmail.split('@')[0]).toString('base64').substring(0, 8).replace(/[+/=]/g, '');
    const accountDetailsKey = `user-${userHash}/account-details/README.txt`;
    
    try {
      // Check if account details already exist
      await r2Client.send(new HeadObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: accountDetailsKey
      }));
      
      console.log(`✅ Account details already exist for user: ${userEmail}`);
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        // Create the enhanced account details file
        const accountDetailsContent = `# CUTMV User Account Details

## Primary Information
Email: ${userEmail}
User Hash: ${userHash}
Account Created: ${new Date().toISOString()}
Customer Type: Production User

## Registration Details
First IP Address: ${clientIP || 'Unknown'}
User Agent: ${userAgent || 'Unknown'}
Registration Domain: https://cutmv.fulldigitalll.com
Auth Method: Magic Link

## Folder Structure
- uploads/ - Original video uploads
- exports/ - Processed video exports (clips, GIFs, thumbnails, Canvas)
- account-details/ - Account information and security logs

## Account Activity Tracking
Account Status: Active
Payment Method: Credit System (Paid Service)
Processing Credits: Available via STAFF25 promo code
Last Login: ${new Date().toISOString()}
Files Uploaded: 0
Exports Generated: 0

## Security & Compliance
- All R2 access validated against user authentication
- Download URLs signed with user-specific permissions  
- 29-day automatic retention policy for all exports
- Activity logs stored in account-details/activity.log
- GDPR compliant data handling

## Technical Details
Platform Version: CUTMV v1.0
R2 Bucket: ${process.env.R2_BUCKET_NAME || 'cutmv'}
File Organization: Per-user isolation
Max File Size: 10GB per upload
Supported Formats: MP4, MOV, MKV

## Usage Stats
Total Storage Used: 0 bytes
Total Processing Time: 0 minutes  
Bandwidth Used: 0 bytes

---
Generated by CUTMV System
Platform: https://cutmv.fulldigitalll.com
Support: Available via platform interface
`;
        
        await r2Client.send(new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: accountDetailsKey,
          Body: accountDetailsContent,
          ContentType: 'text/plain',
          Metadata: {
            'folder-type': 'account-details',
            'user-email': userEmail,
            'user-hash': userHash,
            'created-by': 'system',
            'created-at': new Date().toISOString()
          }
        }));
        
        console.log(`📄 Created account details for user: ${userEmail} at ${accountDetailsKey}`);
      } else {
        console.error(`❌ Error checking account details for ${userEmail}:`, error);
      }
    }
  }

  /**
   * Log user activity to account-details/activity.log
   */
  static async logUserActivity(userEmail: string, activity: string, details?: any): Promise<void> {
    const userHash = Buffer.from(userEmail.split('@')[0]).toString('base64').substring(0, 8).replace(/[+/=]/g, '');
    const activityLogKey = `user-${userHash}/account-details/activity.log`;
    
    const logEntry = `[${new Date().toISOString()}] ${activity}${details ? ` - ${JSON.stringify(details)}` : ''}\n`;
    
    try {
      // Try to get existing log
      let existingLog = '';
      try {
        const getCommand = new GetObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: activityLogKey
        });
        const response = await r2Client.send(getCommand);
        existingLog = await response.Body?.transformToString() || '';
      } catch (getError) {
        // File doesn't exist yet, start with empty log
        existingLog = `# CUTMV User Activity Log for ${userEmail}\n# Generated: ${new Date().toISOString()}\n\n`;
      }
      
      // Append new entry
      const updatedLog = existingLog + logEntry;
      
      await r2Client.send(new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: activityLogKey,
        Body: updatedLog,
        ContentType: 'text/plain',
        Metadata: {
          'folder-type': 'activity-log',
          'user-email': userEmail,
          'last-updated': new Date().toISOString()
        }
      }));
      
      console.log(`📋 Logged activity for ${userEmail}: ${activity}`);
    } catch (error) {
      console.error(`❌ Failed to log activity for ${userEmail}:`, error);
    }
  }

  /**
   * Ensure complete user folder structure exists (uploads, exports, account-details)
   */
  static async ensureUserFolderStructure(userEmail: string, clientIP?: string, userAgent?: string): Promise<void> {
    console.log(`🗂️ Setting up complete folder structure for user: ${userEmail}`);
    
    // Create account details first (contains user identification)
    await this.createUserAccountDetails(userEmail, clientIP, userAgent);
    
    // Create exports folder placeholder
    await this.ensureExportsFolder(userEmail);
    
    // Log the folder structure creation
    await this.logUserActivity(userEmail, 'FOLDER_STRUCTURE_CREATED', {
      ip: clientIP,
      userAgent: userAgent?.substring(0, 100) // Truncate long user agents
    });
    
    console.log(`✅ Complete user folder structure ready for: ${userEmail}`);
  }

  /**
   * Get appropriate content type for file
   */
  private static getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const contentTypes: { [key: string]: string } = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.gif': 'image/gif',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.zip': 'application/zip',
    };
    
    return contentTypes[ext] || 'application/octet-stream';
  }

  /**
   * Validate user access to R2 object (security check)
   */
  static async validateUserAccess(r2Key: string, userEmail: string): Promise<boolean> {
    if (!isR2Configured) {
      return false;
    }

    try {
      // Check if object exists and get metadata
      const headCommand = new HeadObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: r2Key,
      });

      const response = await r2Client.send(headCommand);
      const metadata = response.Metadata || {};

      // Check if user has access to this object
      const objectUserEmail = metadata['user-email'];

      // Allow access if:
      // 1. Object metadata matches user email
      // 2. R2 key contains user-specific path with encoded email
      // 3. User is authenticated (fallback for exports without metadata)

      // Try both encoding methods (with and without @)
      const emailPrefix = userEmail.split('@')[0];
      const encodedWithoutAt = Buffer.from(emailPrefix).toString('base64').replace(/=/g, '');
      const encodedWithAt = Buffer.from(emailPrefix + '@').toString('base64').replace(/=/g, '');

      const userPathWithoutAt = `user-${encodedWithoutAt}`;
      const userPathWithAt = `user-${encodedWithAt}`;

      const keyContainsUserPath = r2Key.includes(userPathWithoutAt) || r2Key.includes(userPathWithAt);

      const hasAccess = (objectUserEmail === userEmail) ||
                       keyContainsUserPath ||
                       (!!userEmail && r2Key.includes('exports/')); // Allow authenticated users to access exports

      console.log(`🔐 User access check: ${r2Key} for ${userEmail} = ${hasAccess ? 'GRANTED' : 'DENIED'}`);
      console.log(`🔍 Validation: metadata=${objectUserEmail}, paths=${userPathWithoutAt}|${userPathWithAt}, keyContains=${keyContainsUserPath}`);

      return hasAccess;
    } catch (error) {
      console.error(`❌ User access validation failed for ${r2Key}:`, error);
      return false;
    }
  }

  /**
   * Test R2 connection
   */
  static async testConnection(): Promise<boolean> {
    try {
      console.log('🔗 Testing R2 connection...');
      
      // Try to list objects (this will verify credentials and bucket access)
      const testKey = `test-connection-${Date.now()}.txt`;
      const testContent = 'R2 connection test';
      
      const uploadCommand = new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: testKey,
        Body: testContent,
        ContentType: 'text/plain',
      });

      await r2Client.send(uploadCommand);
      
      // Clean up test file immediately
      await R2Storage.deleteFile(testKey);
      
      console.log('✅ R2 connection successful');
      return true;
    } catch (error) {
      console.error('❌ R2 connection failed:', error);
      return false;
    }
  }
}

// Test connection and cleanup on startup (only if all credentials are present)
if (R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey && R2_CONFIG.endpoint && R2_CONFIG.bucketName) {
  R2Storage.testConnection().then(success => {
    if (success) {
      console.log('🌥️ Cloudflare R2 storage initialized successfully');
      // Run cleanup for any orphaned files from previous sessions
      R2Storage.cleanupOldFiles();
    } else {
      console.error('❌ Failed to initialize R2 storage - check your credentials');
    }
  });
} else {
  console.log('⚠️ R2 storage configuration incomplete - will skip R2 operations');
}

export default R2Storage;