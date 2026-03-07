// Background Job Manager for Email Delivery System
// Handles persistent processing jobs with email notifications

import { emailService } from './email-service.js';
import { storage } from './storage.js';
import { calculateJobDeadline } from './timeout-config.js';
import { referralService } from './services/referral-service.js';
// Note: accurateProgressTracker import removed - will use enhanced processor directly
import type { BackgroundJob, InsertBackgroundJob, EmailDelivery, Video } from '../shared/schema.js';
import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';

// Helper function to analyze ZIP file contents and count exports
async function analyzeZipContents(zipPath: string): Promise<{
  clipsGenerated: number;
  gifsGenerated: number;
  thumbnailsGenerated: number;
  canvasGenerated: number;
}> {
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    
    let clipsGenerated = 0;
    let gifsGenerated = 0;
    let thumbnailsGenerated = 0;
    let canvasGenerated = 0;
    
    console.log(`📁 ZIP contains ${entries.length} files:`, entries.map(e => e.entryName));
    
    for (const entry of entries) {
      const fileName = entry.entryName.toLowerCase();
      console.log(`🔍 Analyzing file: ${fileName}`);
      
      // Count video clips - be more flexible with naming patterns
      if (fileName.endsWith('.mp4') && (fileName.includes('clip') || fileName.includes('cutdown') || fileName.includes('export'))) {
        clipsGenerated++;
        console.log(`  ✅ Counted as video clip`);
      }
      // Count GIFs
      else if (fileName.endsWith('.gif')) {
        gifsGenerated++;
        console.log(`  ✅ Counted as GIF`);
      }
      // Count thumbnails - be more flexible with naming
      else if ((fileName.endsWith('.jpg') || fileName.endsWith('.png') || fileName.endsWith('.jpeg')) && 
               (fileName.includes('thumbnail') || fileName.includes('thumb') || fileName.includes('preview'))) {
        thumbnailsGenerated++;
        console.log(`  ✅ Counted as thumbnail`);
      }
      // Count Canvas loops - be more flexible with naming
      else if (fileName.endsWith('.mp4') && (fileName.includes('canvas') || fileName.includes('loop'))) {
        canvasGenerated++;
        console.log(`  ✅ Counted as canvas loop`);
      }
      // If it's an MP4 and we haven't categorized it yet, it's probably a clip
      else if (fileName.endsWith('.mp4')) {
        clipsGenerated++;
        console.log(`  ✅ Counted MP4 as video clip (fallback)`);
      }
    }
    
    console.log(`📊 ZIP Analysis: ${entries.length} total files - ${clipsGenerated} clips, ${gifsGenerated} GIFs, ${thumbnailsGenerated} thumbnails, ${canvasGenerated} canvas`);
    
    return {
      clipsGenerated,
      gifsGenerated,
      thumbnailsGenerated,
      canvasGenerated
    };
  } catch (error) {
    console.error('Error analyzing ZIP contents:', error);
    // Return safe defaults if analysis fails
    return {
      clipsGenerated: 0,
      gifsGenerated: 0,
      thumbnailsGenerated: 0,
      canvasGenerated: 0
    };
  }
}

interface JobProcessingOptions {
  timestampText: string;
  generateCutdowns?: boolean;
  generateGif?: boolean;
  generateThumbnails?: boolean;
  generateCanvas?: boolean;
  aspectRatios?: string[];
  quality?: string;
  videoFade?: boolean;
  audioFade?: boolean;
  fadeDuration?: number;
  // Professional service only - no watermark options
  originalFilename?: string;
  duration?: number;
}

class BackgroundJobManager {
  private activeJobs = new Map<string, BackgroundJob>();
  private jobTimeouts = new Map<string, NodeJS.Timeout>();
  private sessionVideoMap = new Map<string, number>(); // Track sessionId -> videoId

  constructor() {
    console.log('📋 Background Job Manager initialized');
  }

  // Track session to video ID mapping
  setVideoIdForSession(sessionId: string, videoId: number): void {
    this.sessionVideoMap.set(sessionId, videoId);
  }

  // Get video ID for session (for thank you page)
  getVideoIdForSession(sessionId: string): number | null {
    return this.sessionVideoMap.get(sessionId) || null;
  }

  // Create a new background processing job
  async createJob(
    sessionId: string,
    videoId: number,
    userEmail: string,
    processingOptions: JobProcessingOptions
  ): Promise<{ success: boolean; jobId?: number; error?: string }> {
    try {
      console.log(`🔧 BackgroundJobManager.createJob() ENTRY:`, {
        sessionId,
        videoId,
        userEmail,
        hasProcessingOptions: !!processingOptions,
        generateCutdowns: processingOptions.generateCutdowns,
        timestampText: processingOptions.timestampText?.substring(0, 50) + '...'
      });
      
      // Create background job record
      const jobData: InsertBackgroundJob = {
        sessionId,
        videoId,
        userEmail,
        jobType: 'video_processing',
        status: 'pending',
        progress: 0,
        processingDetails: JSON.stringify(processingOptions),
        downloadPath: null,
        r2DownloadUrl: null,
        errorMessage: null,
      };
      
      console.log(`📋 Creating background job with data:`, jobData);

      const job = await storage.createBackgroundJob(jobData);
      console.log(`💾 Background job created in storage:`, { 
        success: !!job, 
        id: job?.id, 
        sessionId: job?.sessionId, 
        status: job?.status 
      });
      
      if (!job) {
        throw new Error('Failed to create background job record');
      }

      // Store in active jobs map
      this.activeJobs.set(sessionId, job);

      // Send processing started notification
      const video = await storage.getVideo(videoId);
      console.log(`📹 Retrieved video for notification:`, { 
        hasVideo: !!video, 
        videoId, 
        originalName: video?.originalName 
      });
      
      if (video && userEmail) {
        const estimatedTime = this.calculateEstimatedTime(processingOptions, video.duration);
        console.log(`⏱️ Estimated processing time: ${estimatedTime}`);
        
        console.log(`📧 Using integrated email workflow for processing notification...`);
        
        // Import the integrated email workflow
        const { integratedEmailWorkflow } = await import('./integrated-email-workflow.js');
        
        const emailResult = await integratedEmailWorkflow.sendEmail({
          userEmail,
          emailType: 'processing_started',
          sessionId,
          videoName: video.originalName,
          estimatedTime,
          professionalQuality: true, // All exports are professional quality
          skipVerification: false // Enable Kickbox verification
        });

        if (emailResult.success) {
          console.log(`✅ Processing notification delivered: ${emailResult.messageId}`);
          await this.recordEmailDelivery(sessionId, userEmail, 'processing_started', {
            videoName: video.originalName,
            estimatedTime,
            messageId: emailResult.messageId,
            verificationResult: emailResult.verificationResult
          });
        } else {
          console.error(`❌ Processing notification failed: ${emailResult.error}`);
          // Still record the attempt for tracking
          await this.recordEmailDelivery(sessionId, userEmail, 'processing_started', {
            videoName: video.originalName,
            estimatedTime,
            error: emailResult.error,
            verificationResult: emailResult.verificationResult
          });
        }
      } else {
        console.warn(`⚠️ Cannot send notification - Video: ${!!video}, Email: ${!!userEmail}`);
      }

      // Start processing in background
      this.startProcessing(job, processingOptions);

      console.log(`✅ Background job created: ${job.id} for session ${sessionId}`);
      return { success: true, jobId: job.id };

    } catch (error) {
      console.error('❌ Failed to create background job:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // Public method to start processing from external calls
  async processJobBackground(job: BackgroundJob, options: JobProcessingOptions): Promise<void> {
    return this.startProcessing(job, options);
  }

  // Start processing a background job
  private async startProcessing(job: BackgroundJob, options: JobProcessingOptions) {
    try {
      // Update job status to processing
      await this.updateJobStatus(job.sessionId, 'processing', 0);

      // Get video data first (before calculating timeout)
      const video = await storage.getVideo(job.videoId!);
      if (!video) {
        throw new Error('Video not found');
      }

      // Calculate adaptive timeout based on processing complexity
      const adaptiveTimeoutMs = await this.calculateJobTimeout(video, options);
      const timeoutMinutes = Math.round(adaptiveTimeoutMs / 60000);
      
      const timeout = setTimeout(async () => {
        console.log(`⏰ Job ${job.id} timed out after ${timeoutMinutes} minutes (adaptive timeout)`);
        await this.markJobFailed(job.sessionId, `Processing timeout after ${timeoutMinutes} minutes`);
      }, adaptiveTimeoutMs);

      this.jobTimeouts.set(job.sessionId, timeout);
      
      console.log(`⏰ Set adaptive timeout: ${timeoutMinutes} minutes for job complexity`);

      // Import the enhanced processor (dynamic import to avoid circular dependency)
      const { enhancedProcessor } = await import('./enhanced-process.js');

      // Verify video file exists on R2 using user-specific path
      const { R2Storage } = await import('./r2-storage.js');
      let r2VideoKey;
      
      if (video.r2Key) {
        // Use the stored R2 key if available (new per-user structure)
        r2VideoKey = video.r2Key;
        console.log(`🔍 Using stored R2 key: ${r2VideoKey}`);
      } else {
        // Generate per-user R2 key if not stored
        const userEmail = video.userEmail || job.userEmail;
        if (userEmail) {
          r2VideoKey = R2Storage.generateR2Key(video.filename, 'uploads', userEmail);
          console.log(`🔄 Generated user-specific R2 key: ${r2VideoKey}`);
        } else {
          // Last resort: use legacy path structure
          r2VideoKey = `videos/${video.filename}`;
          console.log(`⚠️ Using legacy path (no user email): ${r2VideoKey}`);
        }
      }
      
      try {
        await R2Storage.getSignedUrl(r2VideoKey, 60); // Test access
        console.log(`✅ Video file found on R2: ${r2VideoKey}`);
      } catch (error) {
        console.error(`❌ Video file not found on R2: ${r2VideoKey}`);
        
        // Try alternative paths if the main one fails
        const alternatives = [];
        if (video.userEmail || job.userEmail) {
          const userEmail = video.userEmail || job.userEmail;
          alternatives.push(R2Storage.generateR2Key(video.filename, 'uploads', userEmail!));
          alternatives.push(`user-${Buffer.from(userEmail!).toString('base64').substring(0, 8)}/uploads/${video.filename}`);
        }
        alternatives.push(`videos/${video.filename}`);
        alternatives.push(`uploads/${video.filename}`);
        
        for (const altKey of alternatives) {
          if (altKey === r2VideoKey) continue; // Skip already tried key
          try {
            await R2Storage.getSignedUrl(altKey, 60);
            console.log(`✅ Video file found with alternative path: ${altKey}`);
            r2VideoKey = altKey;
            break;
          } catch (altError) {
            console.log(`❌ Alternative path failed: ${altKey}`);
          }
        }
        
        // Final check
        try {
          await R2Storage.getSignedUrl(r2VideoKey, 60);
          console.log(`✅ Video verified on final check: ${r2VideoKey}`);
        } catch (finalError) {
          throw new Error(`Video file not found in R2 storage with any known path structure. Tried: ${[r2VideoKey, ...alternatives].join(', ')}`);
        }
      }

      // Start processing with the enhanced processor using correct R2 path
      const result = await enhancedProcessor.startProcessing(job.videoId!, {
        ...video,
        filename: r2VideoKey // Use the correct R2 key as filename for processing
      }, {
        ...options,
        sessionId: job.sessionId,
      });

      if (result.success) {
        // Monitor progress through WebSocket updates
        this.monitorJobProgress(job.sessionId);
      } else {
        throw new Error(result.message || 'Processing failed');
      }

    } catch (error) {
      console.error(`❌ Background processing failed for job ${job.id}:`, error);
      await this.markJobFailed(job.sessionId, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  // Monitor job progress through WebSocket updates
  private monitorJobProgress(sessionId: string) {
    // Create a progress monitoring interval with enhanced stall detection
    const progressInterval = setInterval(async () => {
      const job = this.activeJobs.get(sessionId);
      if (!job) {
        clearInterval(progressInterval);
        return;
      }

      // Check for stalled jobs (no progress for 8 minutes)
      const jobStartTime = job.startedAt ? new Date(job.startedAt).getTime() : (job.createdAt ? new Date(job.createdAt).getTime() : Date.now());
      const timeSinceStart = Date.now() - jobStartTime;
      const lastProgress = (job as any).lastProgress || 0;
      
      if (timeSinceStart > 8 * 60 * 1000 && job.progress === lastProgress) {
        console.warn(`⚠️ Job ${sessionId} appears stalled at ${job.progress}% for ${Math.round(timeSinceStart/60000)} minutes`);
        if (timeSinceStart > 85 * 60 * 1000) { // 85 minute hard timeout for stalled jobs (accommodates FFmpeg max times)
          console.error(`❌ Job ${sessionId} timed out after ${Math.round(timeSinceStart/60000)} minutes at ${job.progress}%`);
          clearInterval(progressInterval);
          await this.markJobFailed(sessionId, `Job timed out after ${Math.round(timeSinceStart/60000)} minutes`);
          return;
        }
      }
      (job as any).lastProgress = job.progress;

      // Check if processing is complete through multiple methods
      try {
        const video = await storage.getVideo(job.videoId!);
        
        if (video) {
          // Method 1: Check enhanced processor status (if available in memory)
          const { enhancedProcessor } = await import('./enhanced-process.js');
          const jobStatus = enhancedProcessor.getJobStatus(video.id);
          
          if (jobStatus) {
            console.log(`🔄 Job monitoring for video ${job.videoId}: status=${jobStatus.status}, completed=${jobStatus.completedOperations}/${jobStatus.totalOperations}`);
            
            // Update progress in database - use percentage from 0-100
            const progressPercent = Math.round(jobStatus.completedOperations / Math.max(jobStatus.totalOperations, 1) * 100);
            await this.updateJobStatus(sessionId, jobStatus.status, progressPercent);

            // Check if completed - use downloadPath
            if (jobStatus.status === 'completed' && jobStatus.downloadPath) {
              console.log(`✅ Job completed detected for video ${job.videoId}: ${jobStatus.downloadPath}`);
              clearInterval(progressInterval);
              await this.markJobCompleted(sessionId, jobStatus.downloadPath, jobStatus.r2DownloadUrl);
              return;
            } else if (jobStatus.status === 'failed') {
              console.log(`❌ Job failed detected for video ${job.videoId}: ${jobStatus.errors.join(', ')}`);
              clearInterval(progressInterval);
              await this.markJobFailed(sessionId, jobStatus.errors.join(', '));
              return;
            }
          } else {
            // Method 2: Check for completed output files (fallback detection)
            console.log(`🔍 No in-memory status found for video ${job.videoId}, checking file system...`);
            
            const expectedZipPath = path.join('uploads', 'clips', `video_${job.videoId}_exports.zip`);
            
            try {
              const stats = await fs.stat(expectedZipPath);
              if (stats.isFile() && stats.size > 0) {
                console.log(`✅ Found completed ZIP file for video ${job.videoId}: ${expectedZipPath} (${stats.size} bytes)`);
                
                // Check if ZIP was created recently (within last 30 minutes)
                const fileAge = Date.now() - stats.mtime.getTime();
                const thirtyMinutes = 30 * 60 * 1000;
                
                if (fileAge < thirtyMinutes) {
                  console.log(`🎉 Processing completed! ZIP file is fresh (${Math.round(fileAge / 1000)}s old)`);
                  
                  // Try to get R2 URL if available
                  let r2DownloadUrl: string | undefined;
                  try {
                    const zipKey = `exports/video_${job.videoId}_exports.zip`;
                    const R2Storage = (await import('./r2-storage.js')).default;
                    r2DownloadUrl = await R2Storage.getSignedUrl(zipKey, 3600);
                    console.log(`☁️ R2 download URL generated: ${r2DownloadUrl}`);
                  } catch (r2Error) {
                    console.log(`⚠️ R2 URL generation failed, using local path: ${r2Error}`);
                  }
                  
                  clearInterval(progressInterval);
                  await this.markJobCompleted(sessionId, `video_${job.videoId}_exports.zip`, r2DownloadUrl);
                  return;
                }
              }
            } catch (fileError) {
              // ZIP file doesn't exist yet, continue monitoring
              console.log(`⏳ Waiting for completion - ZIP file not found: ${expectedZipPath}`);
            }
          }
        }
      } catch (error) {
        console.error('Progress monitoring error:', error);
      }
    }, 5000); // Check every 5 seconds

    // Clean up interval after 30 minutes
    setTimeout(() => {
      clearInterval(progressInterval);
    }, 30 * 60 * 1000);
  }

  // Update job status and progress
  private async updateJobStatus(sessionId: string, status: string, progress: number) {
    try {
      await storage.updateBackgroundJob(sessionId, { status, progress });
      
      // Update local cache
      const job = this.activeJobs.get(sessionId);
      if (job) {
        job.status = status;
        job.progress = progress;
        this.activeJobs.set(sessionId, job);
      }
    } catch (error) {
      console.error('Failed to update job status:', error);
    }
  }

  // Mark job as completed and send download email
  private async markJobCompleted(sessionId: string, downloadPath: string, r2DownloadUrl?: string | null) {
    try {
      const job = this.activeJobs.get(sessionId);
      if (!job) return;

      // Clear timeout
      const timeout = this.jobTimeouts.get(sessionId);
      if (timeout) {
        clearTimeout(timeout);
        this.jobTimeouts.delete(sessionId);
      }

      // Update job status with completion timestamp and expiration (29 days)
      await storage.updateBackgroundJob(sessionId, {
        status: 'completed',
        progress: 100,
        downloadPath,
        r2DownloadUrl,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000), // 29 days from completion
      });

      // Get video details for email
      const video = await storage.getVideo(job.videoId!);
      if (!video) return;

      // Parse processing details
      const processingDetails = JSON.parse(job.processingDetails || '{}');
      
      // Export counts are tracked during processing - no need to analyze ZIP from disk
      let exportCounts = { clipsGenerated: 0, gifsGenerated: 0, thumbnailsGenerated: 0, canvasGenerated: 0 };
      try {
        // Extract counts from processing details instead of local ZIP analysis
        const details = JSON.parse(job.processingDetails || '{}');
        
        // Calculate clips correctly: timestamps × aspect ratios
        let clipsCount = 0;
        if (details.generateCutdowns && details.timestampText && details.aspectRatios?.length) {
          // Parse timestamp lines to count them
          const timestamps = details.timestampText.split('\n').map((line: string) => line.trim()).filter((line: string) => line);
          clipsCount = timestamps.length * details.aspectRatios.length;
          console.log(`📊 Clips calculation: ${timestamps.length} timestamps × ${details.aspectRatios.length} aspect ratios = ${clipsCount} clips`);
        }
        
        // Calculate other format counts based on video duration
        const videoDuration = parseFloat(details.videoDuration?.replace(/[^\d.]/g, '') || '60');
        const gifCount = details.generateGif ? (videoDuration < 40 ? 5 : 10) : 0;
        const thumbnailCount = details.generateThumbnails ? (videoDuration < 40 ? 5 : 10) : 0;
        const canvasCount = details.generateCanvas ? (videoDuration < 40 ? 2 : 5) : 0;
        
        exportCounts = {
          clipsGenerated: clipsCount,
          gifsGenerated: gifCount,
          thumbnailsGenerated: thumbnailCount,
          canvasGenerated: canvasCount
        };
        console.log('📊 Background job completion - export counts from processing details:', exportCounts);
      } catch (parseError) {
        console.error('Failed to parse processing details in background job:', parseError);
      }

      // Generate secure download token and URL - FORCE cutmv.fulldigitalll.com domain
      const { downloadTokenManager } = await import('./download-tokens.js');
      const downloadToken = await downloadTokenManager.generateToken(sessionId, downloadPath, job.userEmail, 24);

      // Use Railway URL if available, otherwise production domain
      const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : (process.env.BASE_URL || 'https://cutmv-production.up.railway.app');
      const downloadUrl = `${baseUrl}/api/secure-download/${downloadToken}`;

      console.log(`🔗 Generated download URL for ${job.userEmail}: /api/secure-download/${downloadToken.substring(0, 8)}...`);
      console.log(`📧 Email will use URL: ${downloadUrl}`);
      
      // Record email delivery
      await this.recordEmailDelivery(sessionId, job.userEmail, 'download_ready', {
        downloadUrl,
        downloadFilename: downloadPath,
        videoName: video.originalName,
        processingDetails,
      });

      // Send download email with video metadata including timestamps
      await emailService.sendDownloadLink({
        userEmail: job.userEmail,
        downloadUrl,
        downloadFilename: downloadPath,
        processingDetails: {
          videoName: video.originalName,
          clipsGenerated: exportCounts.clipsGenerated,
          gifsGenerated: exportCounts.gifsGenerated,
          thumbnailsGenerated: exportCounts.thumbnailsGenerated,
          canvasGenerated: exportCounts.canvasGenerated,
          timestampsUsed: processingDetails.timestampText || processingDetails.timestamps || null,
          processingTime: job.completedAt && job.startedAt 
            ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
            : undefined,
        },
        sessionId,
        videoTitle: video.videoTitle || undefined,
        artistInfo: video.artistInfo || undefined,
        professionalQuality: true, // All exports are professional quality
      });

      // Award first export bonus if this is user's first export
      // This awards a bonus credit to the referrer when the referred user completes their first export
      try {
        const user = await storage.getUserByEmail(job.userEmail);
        if (user) {
          const bonusAwarded = await referralService.processFirstExport(user.id, sessionId);
          if (bonusAwarded) {
            console.log(`🎁 First export bonus credited to referrer for user ${user.id}`);
          }
        }
      } catch (bonusError) {
        console.error('Failed to process first export bonus:', bonusError);
        // Don't fail the job if bonus fails
      }

      // Remove from active jobs
      this.activeJobs.delete(sessionId);

      console.log(`✅ Job ${job.id} completed successfully. Download email sent to ${job.userEmail}`);

    } catch (error) {
      console.error('Failed to mark job as completed:', error);
    }
  }

  // Mark job as failed
  private async markJobFailed(sessionId: string, errorMessage: string) {
    try {
      const job = this.activeJobs.get(sessionId);
      if (!job) return;

      // Clear timeout
      const timeout = this.jobTimeouts.get(sessionId);
      if (timeout) {
        clearTimeout(timeout);
        this.jobTimeouts.delete(sessionId);
      }

      // Update job status
      await storage.updateBackgroundJob(sessionId, {
        status: 'failed',
        errorMessage,
      });

      // TODO: Send failure notification email
      console.log(`❌ Job ${job.id} failed: ${errorMessage}`);

      // Remove from active jobs
      this.activeJobs.delete(sessionId);

    } catch (error) {
      console.error('Failed to mark job as failed:', error);
    }
  }

  // Calculate adaptive timeout based on processing complexity
  private async calculateJobTimeout(video: any, options: any): Promise<number> {
    try {
      // Import enhanced processor to get complexity calculation
      const { enhancedProcessor } = await import('./enhanced-process.js');
      
      // Calculate processing operations (simplified for timeout calculation)
      const simpleOperations: { type: string }[] = [];
      
      // Add cutdown operations
      if (options.generateCutdowns && options.timestamps?.length > 0) {
        const timestampCount = options.timestamps.length;
        for (let i = 0; i < timestampCount; i++) {
          simpleOperations.push({ type: 'cutdown' });
        }
      }
      
      // Add GIF operations
      if (options.generateGif) {
        const videoDuration = parseFloat(video.duration?.replace(/[^\d.]/g, '') || '0');
        const gifCount = videoDuration < 40 ? 5 : 10;
        for (let i = 0; i < gifCount; i++) {
          simpleOperations.push({ type: 'gif' });
        }
      }
      
      // Add thumbnail operations
      if (options.generateThumbnails) {
        const videoDuration = parseFloat(video.duration?.replace(/[^\d.]/g, '') || '0');
        const thumbnailCount = videoDuration < 40 ? 5 : 10;
        for (let i = 0; i < thumbnailCount; i++) {
          simpleOperations.push({ type: 'thumbnail' });
        }
      }
      
      // Add Canvas operations
      if (options.generateCanvas && options.timestamps?.length > 0) {
        const canvasCount = options.timestamps.length;
        for (let i = 0; i < canvasCount; i++) {
          simpleOperations.push({ type: 'canvas' });
        }
      }
      
      // Create proper ProcessingOperation objects for enhanced processor
      const fullOperations = simpleOperations.map((op, index) => ({
        type: op.type as 'cutdown' | 'gif' | 'thumbnail' | 'canvas',
        id: `${op.type}_${index}`,
        inputPath: '',
        outputPath: '',
        options: {},
        duration: 0,
        status: 'pending' as const,
        progress: 0
      }));
      
      // Use unified deadline system instead of legacy adaptive timeout
      const videoDurationSeconds = this.parseVideoDuration(video.duration || '00:01:00.00');
      const fileSizeGB = (video.size || 0) / (1024 * 1024 * 1024);
      const exportTypes = fullOperations.map(op => op.type);
      
      const deadline = calculateJobDeadline(
        videoDurationSeconds,
        fileSizeGB,
        fullOperations.length,
        exportTypes
      );
      
      console.log(`📊 Unified deadline calculated: ${deadline.totalMinutes.toFixed(1)} minutes for complexity:`, {
        operations: fullOperations.length,
        fileSize: fileSizeGB.toFixed(2) + 'GB',
        exportTypes: exportTypes,
        videoDuration: videoDurationSeconds + 's'
      });
      
      return deadline.totalMinutes * 60 * 1000; // Convert to milliseconds for compatibility
      
    } catch (error) {
      console.error('❌ Failed to calculate unified deadline, using fallback:', error);
      return 60 * 60 * 1000; // 60 minutes fallback (aligned with unified system)
    }
  }
  
  // Helper method to parse video duration string
  private parseVideoDuration(duration: string): number {
    // Parse duration format "00:02:30.00" to seconds
    const parts = duration.split(':');
    if (parts.length >= 3) {
      const hours = parseInt(parts[0]) || 0;
      const minutes = parseInt(parts[1]) || 0;
      const seconds = parseFloat(parts[2]) || 0;
      return hours * 3600 + minutes * 60 + seconds;
    }
    return 60; // Default 1 minute if parsing fails
  }

  // Record email delivery attempt
  private async recordEmailDelivery(
    sessionId: string, 
    userEmail: string, 
    emailType: string, 
    details: any
  ) {
    try {
      await storage.createEmailDelivery({
        sessionId,
        userEmail,
        emailType,
        messageId: null,
        status: 'pending',
        downloadUrl: details.downloadUrl || null,
        downloadFilename: details.downloadFilename || null,
        processingDetails: JSON.stringify(details),
        errorMessage: null,
      });
    } catch (error) {
      console.error('Failed to record email delivery:', error);
    }
  }

  // Calculate estimated processing time
  private calculateEstimatedTime(options: JobProcessingOptions, duration?: string | null): string {
    let baseTime = 30; // Base 30 seconds
    
    // Add time based on features
    if (options.generateCutdowns) baseTime += 60;
    if (options.generateGif) baseTime += 45;
    if (options.generateThumbnails) baseTime += 15;
    if (options.generateCanvas) baseTime += 30;
    
    // Add time based on video duration
    if (duration) {
      const durationSeconds = this.parseDuration(duration);
      baseTime += Math.floor(durationSeconds / 10); // 1 second per 10 seconds of video
    }

    return `${Math.ceil(baseTime / 60)} minutes`;
  }

  // Parse duration string to seconds
  private parseDuration(duration: string): number {
    const parts = duration.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parseInt(duration) || 0;
  }

  // Get job status for user
  async getJobStatus(sessionId: string): Promise<BackgroundJob | null> {
    const job = this.activeJobs.get(sessionId);
    if (job) return job;

    // Try to get from storage
    const storedJob = await storage.getBackgroundJob(sessionId);
    return storedJob || null;
  }

  // Check if user has reached maximum concurrent jobs (processing or pending)
  async hasActiveJob(userEmail: string): Promise<boolean> {
    try {
      const activeJobs = await storage.getActiveJobsByUser(userEmail);
      const maxConcurrentJobs = 3; // Increased from 1 to 3 concurrent exports
      return activeJobs.length >= maxConcurrentJobs;
    } catch (error) {
      console.error('Error checking active jobs:', error);
      return false;
    }
  }

  // Cancel job
  async cancelJob(sessionId: string): Promise<boolean> {
    try {
      const job = this.activeJobs.get(sessionId);
      if (!job) return false;

      // Clear timeout
      const timeout = this.jobTimeouts.get(sessionId);
      if (timeout) {
        clearTimeout(timeout);
        this.jobTimeouts.delete(sessionId);
      }

      // Cancel in enhanced processor
      const { enhancedProcessor } = await import('./enhanced-process.js');
      const video = await storage.getVideo(job.videoId!);
      if (video) {
        enhancedProcessor.cancelJob(video.id);
      }

      // Update status
      await this.markJobFailed(sessionId, 'Cancelled by user');

      return true;
    } catch (error) {
      console.error('Failed to cancel job:', error);
      return false;
    }
  }
}

// Export singleton instance
export const backgroundJobManager = new BackgroundJobManager();
export type { JobProcessingOptions };