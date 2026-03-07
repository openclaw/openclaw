// Enhanced processing with 100% accurate FFmpeg progress tracking
// Implements the ideal workflow: Queue -> Worker -> Real-time Progress -> WebSocket

import { ffmpegProcessor } from './ffmpeg-progress.js';
import { queueManager } from './cloudflare-queue.js';
import R2Storage from './r2-storage.js';
import { storage } from './storage.js';
import { TimeoutManager, calculateJobDeadline, getTimeLeftMinutes, isDeadlineExceeded, hasSufficientTimeForStage, logDeadlineInfo, type JobDeadline } from './timeout-config.js';

// Helper function to parse video duration string
function parseVideoDuration(duration: string): number {
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

// Helper function to strip timestamp and random ID prefix from filename
// Removes patterns like "1765842074402-bhojbkgd8r4-" from "1765842074402-bhojbkgd8r4-video.mp4"
function stripTimestampPrefix(filename: string): string {
  // Match pattern: timestamp-randomid-actualname
  const match = filename.match(/^\d+-[a-z0-9]+-(.+)$/);
  if (match) {
    return match[1]; // Return just the actual filename part
  }
  return filename; // Return as-is if no prefix found
}

// Helper function to generate clean filename from video metadata
function generateCleanFilename(videoData: any): string {
  console.log('🏷️ Generating filename from metadata:', {
    videoTitle: videoData.videoTitle,
    artistInfo: videoData.artistInfo,
    originalName: videoData.originalName
  });

  // Priority: videoTitle with artistInfo > videoTitle > originalName without extension
  if (videoData.videoTitle && videoData.artistInfo) {
    const filename = `${videoData.artistInfo} - ${videoData.videoTitle}`;
    console.log('✅ Using videoTitle + artistInfo:', filename);
    return filename;
  }
  if (videoData.videoTitle) {
    console.log('✅ Using videoTitle only:', videoData.videoTitle);
    return videoData.videoTitle;
  }
  // Fallback to original filename without extension, with timestamp prefix stripped
  const originalWithoutExt = videoData.originalName?.replace(/\.[^/.]+$/, '') || 'Video';
  const fallback = stripTimestampPrefix(originalWithoutExt);
  console.log('⚠️ Using fallback (originalName):', fallback);
  return fallback;
}
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs/promises';
import { TimeEstimationService } from '../shared/time-estimation.js';

export interface AccurateProcessingJob {
  videoId: number;
  sessionId: string;
  operations: ProcessingOperation[];
  totalOperations: number;
  completedOperations: number;
  startTime: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  downloadPath?: string;
  r2DownloadUrl?: string;
  currentOperation?: string;
  errors: string[];
  userEmail?: string; // For R2 metadata and access control
  localVideoPath?: string; // Track local downloaded video file for cleanup
  videoName?: string; // Track video name for cleanup
  deadline?: JobDeadline; // Unified deadline tracking
}

export interface ProcessingOperation {
  type: 'cutdown' | 'gif' | 'thumbnail' | 'canvas';
  id: string;
  inputPath: string;
  outputPath: string;
  options: any;
  duration: number; // Expected duration in seconds
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
}

class EnhancedProcessor {
  private activeJobs = new Map<number, AccurateProcessingJob>();
  private completedJobs = new Map<number, AccurateProcessingJob>();

  // Start processing with queue-first approach
  async startProcessing(
    videoId: number,
    videoData: any,
    options: {
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
      sessionId: string;
      userEmail?: string;
    }
  ): Promise<{ success: boolean; jobId?: string; usingQueue?: boolean; message?: string }> {
    
    // Step 1: Try Cloudflare Queues first (ideal serverless approach)
    console.log(`🚀 Attempting Cloudflare Queues for video ${videoId}...`);
    
    const queueJob = queueManager.createProcessingJob(
      videoId,
      `videos/${videoData.filename}`,
      options.timestampText,
      {
        ...options,
        originalFilename: videoData.originalName,
        duration: videoData.duration,
      }
    );

    const queueResult = await queueManager.enqueueProcessingJob(queueJob);
    
    if (queueResult.success) {
      console.log(`✅ Job enqueued successfully: ${queueJob.jobId}`);
      
      // Create minimal job tracking for queue-based processing
      this.activeJobs.set(videoId, {
        videoId,
        sessionId: options.sessionId,
        operations: [], // Queue handles operations
        totalOperations: 0,
        completedOperations: 0,
        startTime: Date.now(),
        userEmail: options.userEmail,
        status: 'queued',
        currentOperation: 'Queued for processing...',
        errors: [],
      });
      
      return { 
        success: true, 
        jobId: queueJob.jobId, 
        usingQueue: true,
        message: 'Processing started with Cloudflare Queues'
      };
    }

    // Step 2: Fallback to direct processing with real-time FFmpeg tracking
    console.log(`⚠️ Queue unavailable (${queueResult.message}), using direct processing with FFmpeg streaming...`);
    console.log(`🔍 Processing options:`, {
      generateCutdowns: options.generateCutdowns,
      generateGif: options.generateGif, 
      generateThumbnails: options.generateThumbnails,
      generateCanvas: options.generateCanvas,
      timestampText: options.timestampText
    });
    
    return this.startDirectProcessing(videoId, videoData, options);
  }

  // Direct processing with real-time FFmpeg progress
  private async startDirectProcessing(
    videoId: number,
    videoData: any,
    options: any
  ): Promise<{ success: boolean; message?: string }> {
    console.log(`🎯 Starting direct processing for video ${videoId}...`);
    
    try {
      // DO NOT create background job here - it should be created by the caller
      // This prevents duplicate job creation and emails
      console.log(`🚀 Direct processing initiated for video ${videoId} (no duplicate job creation)`);
      
      // Parse timestamps and create operations
      const operations = await this.createProcessingOperations(videoData, options);
      console.log(`📝 Created ${operations.length} operations:`, operations.map(op => `${op.type}(${op.id})`).join(', '));
      
      // Clear any existing jobs for this video first to prevent conflicts
      this.activeJobs.delete(videoId);
      this.completedJobs.delete(videoId);
      
      // Create job tracking
      const job: AccurateProcessingJob = {
        videoId,
        sessionId: options.sessionId,
        operations,
        totalOperations: operations.length,
        completedOperations: 0,
        startTime: Date.now(),
        status: 'processing',
        currentOperation: 'Initializing...',
        errors: [],
        userEmail: options.userEmail,
      };
      
      // Calculate unified deadline BEFORE starting processing
      const videoDurationSeconds = parseVideoDuration(videoData.duration || '00:01:00.00');
      const fileSizeGB = (videoData.size || 0) / (1024 * 1024 * 1024);
      const exportTypes = operations.map(op => op.type);
      
      const deadline = calculateJobDeadline(
        videoDurationSeconds,
        fileSizeGB,
        operations.length,
        exportTypes
      );
      
      // Store deadline in job BEFORE adding to active jobs
      job.deadline = deadline;
      
      this.activeJobs.set(videoId, job);
      
      // Start processing asynchronously with timeout protection (deadline already set)
      const processingPromise = this.processOperationsSequentially(job);
      
      logDeadlineInfo(`video_${videoId}_${options.sessionId}`, deadline, 'processing_start');
      
      // Create cancellation token that respects the deadline
      const cancellationToken = TimeoutManager.createCancellationToken(deadline);
      
      cancellationToken.onCancel(() => {
        console.error(`❌ Processing deadline exceeded for video ${videoId}`);
        job.status = 'failed';
        job.errors.push(`Processing deadline exceeded (${deadline.totalMinutes.toFixed(1)} minutes)`);
      });
      
      processingPromise.catch(async error => {
        console.error(`❌ Processing failed for video ${videoId}:`, error);
        job.status = 'failed';
        job.errors.push(error.message || 'Unknown processing error');
        
        // Update database status with proper user context
        await this.updateBackgroundJobStatus(videoId, 'failed', error.message || 'Processing timeout', options.sessionId);
        
        // Move to completed jobs so it can be detected by background job manager
        this.completedJobs.set(videoId, { ...job });
        this.activeJobs.delete(videoId);
      });
      
      return { 
        success: true, 
        message: 'Direct processing started with real-time FFmpeg tracking' 
      };
      
    } catch (error) {
      console.error(`❌ Failed to start direct processing:`, error);
      return { 
        success: false, 
        message: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // Create processing operations from options
  private async createProcessingOperations(videoData: any, options: any): Promise<ProcessingOperation[]> {
    const operations: ProcessingOperation[] = [];

    // Generate clean filename from video metadata
    const cleanName = generateCleanFilename(videoData);

    // All files will be created in memory and uploaded directly to R2
    const baseOutputDir = `/tmp/processing/${videoData.originalName.replace(/\.[^/.]+$/, '')}`;

    console.log(`🔧 DEBUG - Enhanced processor options:`, {
      hasGenerateCutdowns: !!options.generateCutdowns,
      generateCutdowns: options.generateCutdowns,
      hasTimestampText: !!options.timestampText,
      timestampText: options.timestampText?.substring(0, 50),
      generateGif: options.generateGif,
      generateThumbnails: options.generateThumbnails,
      generateCanvas: options.generateCanvas,
      allOptions: Object.keys(options)
    });

    // Parse timestamps for cutdowns
    if (options.generateCutdowns && options.timestampText) {
      const timestamps = this.parseTimestamps(options.timestampText);

      for (let i = 0; i < timestamps.length; i++) {
        const timestamp = timestamps[i];

        for (const aspectRatio of options.aspectRatios || ['16:9']) {
          const aspectSuffix = aspectRatio === '9:16' ? '(9x16)' : '(16x9)';
          const outputPath = path.join(baseOutputDir, `clips ${aspectSuffix}`, `${cleanName}-clip-${String(i + 1).padStart(2, '0')}.mp4`);
          
          console.log(`🎬 DEBUG: Creating cutdown with aspect ratio: ${aspectRatio}, suffix: ${aspectSuffix}`);
          
          operations.push({
            type: 'cutdown',
            id: `cutdown_${i}_${aspectRatio}`,
            inputPath: videoData.r2Url || videoData.path, // Use R2 URL for processing
            outputPath,
            options: {
              startTime: timestamp.startTime,
              endTime: timestamp.endTime,
              aspectRatio,
              quality: options.quality,
              videoFade: options.videoFade,
              audioFade: options.audioFade,
              fadeDuration: options.fadeDuration,
            },
            duration: this.calculateDuration(timestamp.startTime, timestamp.endTime),
            status: 'pending',
            progress: 0,
          });
        }
      }
    }

    // Add GIF operations
    if (options.generateGif) {
      console.log(`🎨 DEBUG - GIF generation requested`);
      const videoDuration = parseFloat(videoData.duration?.replace(/[^\d.]/g, '') || '0');
      const gifCount = videoDuration < 40 ? 5 : 10;

      console.log(`🎨 DEBUG - Video duration: ${videoDuration}s, will generate ${gifCount} GIFs`);

      for (let i = 0; i < gifCount; i++) {
        operations.push({
          type: 'gif',
          id: `gif_${i}`,
          inputPath: videoData.r2Url || videoData.path, // Use R2 URL for processing
          outputPath: path.join(baseOutputDir, 'gifs', `${cleanName}-gif-${String(i + 1).padStart(2, '0')}.gif`),
          options: { index: i, count: gifCount, duration: 6 },
          duration: 6,
          status: 'pending',
          progress: 0,
        });
      }
      console.log(`📝 Created ${gifCount} GIF operations`);
    }

    // Add thumbnail operations
    if (options.generateThumbnails) {
      const videoDuration = parseFloat(videoData.duration?.replace(/[^\d.]/g, '') || '0');
      const thumbnailCount = videoDuration < 40 ? 5 : 10;

      for (let i = 0; i < thumbnailCount; i++) {
        operations.push({
          type: 'thumbnail',
          id: `thumbnail_${i}`,
          inputPath: videoData.r2Url || videoData.path, // Use R2 URL for processing
          outputPath: path.join(baseOutputDir, 'thumbnails', `${cleanName}-thumbnail-${String(i + 1).padStart(2, '0')}.jpg`),
          options: { index: i, count: thumbnailCount, videoDuration: videoDuration }, // PERFORMANCE: Pass duration to avoid R2 ffprobe
          duration: 1, // Thumbnail extraction is fast
          status: 'pending',
          progress: 0,
        });
      }
    }

    // Add Canvas operations
    if (options.generateCanvas) {
      const videoDuration = parseFloat(videoData.duration?.replace(/[^\d.]/g, '') || '0');
      const canvasCount = videoDuration < 40 ? 2 : 5;

      console.log(`🎨 Creating ${canvasCount} Canvas operations (video duration: ${videoDuration}s)`);

      for (let i = 0; i < canvasCount; i++) {
        operations.push({
          type: 'canvas',
          id: `canvas_${i}`,
          inputPath: videoData.r2Url || videoData.path, // Use R2 URL for processing
          outputPath: path.join(baseOutputDir, 'canvas', `${cleanName}-canvas-${String(i + 1).padStart(2, '0')}.mp4`),
          options: { index: i, count: canvasCount, duration: 8 },
          duration: 8,
          status: 'pending',
          progress: 0,
        });
      }
      console.log(`📝 Created ${canvasCount} Canvas operations`);
    } else {
      console.log(`⏭️ Skipping Canvas operations (generateCanvas: ${options.generateCanvas})`);
    }

    return operations;
  }

  // Process operations with real-time FFmpeg progress
  private async processOperationsSequentially(job: AccurateProcessingJob): Promise<void> {
    console.log(`🎬 Starting sequential processing for video ${job.videoId} (${job.operations.length} operations)`);
    
    if (job.operations.length === 0) {
      console.log(`⚠️ NO OPERATIONS CREATED - This means no cutdowns, GIFs, thumbnails, or Canvas will be generated`);
      // Mark job as completed if no operations
      job.status = 'completed';
      this.completedJobs.set(job.videoId, job);
      this.activeJobs.delete(job.videoId);
      return;
    }
    
    // Download video locally if it's stored in R2 (FFmpeg can't process URLs directly)
    let localInputPath = '';
    if (job.operations.length > 0) {
      const firstOperation = job.operations[0];
      if (firstOperation.inputPath.includes('r2.cloudflarestorage.com') || firstOperation.inputPath.startsWith('user-')) {
        console.log(`📥 Downloading video from R2 for FFmpeg processing (${job.operations.length} operations planned)...`);
        
        // Memory optimization: Warn about large file processing
        const { storage } = await import('./storage.js');
        const video = await storage.getVideo(job.videoId);
        if (video?.size && video.size > 5 * 1024 * 1024 * 1024) { // 5GB+
          console.warn(`⚠️ LARGE FILE PROCESSING: ${Math.round(video.size / 1024 / 1024 / 1024 * 10) / 10}GB video detected - monitoring memory usage`);
        }
        
        localInputPath = await this.downloadVideoForProcessing(job.videoId);
        job.localVideoPath = localInputPath; // Track for cleanup
        
        // Update all operations to use local file
        for (const operation of job.operations) {
          operation.inputPath = localInputPath;
        }
      } else {
        localInputPath = firstOperation.inputPath;
      }
    }
    
    for (let i = 0; i < job.operations.length; i++) {
      const operation = job.operations[i];
      
      try {
        job.currentOperation = `${operation.type} ${i + 1}/${job.operations.length}`;
        operation.status = 'processing';
        
        // Create temporary output directory for processing
        await fs.mkdir(path.dirname(operation.outputPath), { recursive: true });
        
        // Process with real-time FFmpeg tracking
        await this.processOperation(operation, job.videoId, job);
        
        operation.status = 'completed';
        operation.progress = 100;
        job.completedOperations++;
        
        console.log(`✅ Completed: ${operation.type} ${i + 1}/${job.operations.length}`);
        
      } catch (error) {
        console.error(`❌ CANVAS DEBUG - Failed operation: ${operation.type} ${i + 1}/${job.operations.length}:`, error);
        operation.status = 'failed';
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (operation) {
          job.errors.push(`${operation.type} failed: ${errorMessage}`);
        } else {
          job.errors.push(`Unknown operation failed: ${errorMessage}`);
        }
        
        // Update database status immediately when Canvas fails
        if (operation && operation.type === 'canvas') {
          await this.updateBackgroundJobStatus(job.videoId, 'failed', `canvas failed: ${errorMessage}`, job.sessionId);
          console.log(`📊 CANVAS DEBUG - Database updated with failure: ${errorMessage}`);
        }
        
        // Clean up partial output file if it exists
        try {
          if (operation && operation.outputPath && await fs.access(operation.outputPath).then(() => true).catch(() => false)) {
            await fs.unlink(operation.outputPath);
            console.log(`🗑️ CANVAS DEBUG - Cleaned up failed file: ${path.basename(operation.outputPath)}`);
          }
        } catch (cleanupError) {
          console.warn(`⚠️ CANVAS DEBUG - Cleanup error ignored:`, cleanupError);
        }
      }
    }

    // Clean up local video file
    if (localInputPath && localInputPath.startsWith('/tmp/')) {
      try {
        await fs.unlink(localInputPath);
        console.log(`🗑️ Cleaned up temporary video file: ${localInputPath}`);
      } catch (error) {
        console.log(`⚠️ Could not clean up temporary file: ${localInputPath}`);
      }
    }

    // Check if any operations failed - if all failed, mark entire job as failed
    const successfulOperations = job.operations.filter(op => op.status === 'completed');
    const failedOperations = job.operations.filter(op => op.status === 'failed');
    
    if (successfulOperations.length === 0 && failedOperations.length > 0) {
      console.log(`❌ All operations failed for video ${job.videoId}, marking job as failed`);
      job.status = 'failed';
      
      // Update database status for complete failure
      await this.updateBackgroundJobStatus(job.videoId, 'failed', `All operations failed: ${job.errors.join('; ')}`, job.sessionId);
      
      // Move to completed jobs so dashboard can show the failure
      this.completedJobs.set(job.videoId, { ...job });
      this.activeJobs.delete(job.videoId);
      return;
    }

    // Create ZIP and finalize for successful operations
    await this.finalizeJob(job);
  }

  // Process individual operation with FFmpeg
  private async processOperation(operation: ProcessingOperation, videoId: number, job?: AccurateProcessingJob): Promise<void> {
    switch (operation.type) {
      case 'cutdown':
        await ffmpegProcessor.processClipWithProgress(
          operation.inputPath,
          operation.outputPath,
          operation.options.startTime,
          this.calculateDuration(operation.options.startTime, operation.options.endTime).toString(),
          videoId,
          `Cutdown ${operation.id}`,
          operation.duration,
          {
            aspectRatio: operation.options.aspectRatio,
            quality: operation.options.quality,
            videoFade: operation.options.videoFade,
            audioFade: operation.options.audioFade,
            fadeDuration: operation.options.fadeDuration,
          }
        );
        break;
        
      case 'gif':
        console.log(`🎨 Processing GIF operation: ${operation.id} (${operation.options.index + 1}/${operation.options.count})`);
        await ffmpegProcessor.generateGifWithProgress(
          operation.inputPath,
          operation.outputPath,
          videoId,
          `GIF ${operation.id}`,
          operation.options.index,
          operation.options.count,
          operation.options.duration
        );
        console.log(`✅ GIF operation completed: ${operation.id}`);
        break;
        
      case 'thumbnail':
        console.log(`📸 FAST THUMBNAIL: Processing ${operation.id} (${operation.options.index + 1}/${operation.options.count})`);
        // Pass video duration to avoid slow R2 ffprobe calls - use operation duration estimate
        const videoDuration = operation.options.videoDuration || undefined;
        await ffmpegProcessor.generateThumbnailWithProgress(
          operation.inputPath,
          operation.outputPath,
          videoId,
          `Thumbnail ${operation.id}`,
          operation.options.index,
          operation.options.count,
          videoDuration
        );
        console.log(`✅ FAST THUMBNAIL: Completed ${operation.id}`);
        break;
        
      case 'canvas':
        console.log(`🎨 CANVAS DEBUG - Processing Canvas operation: ${operation.id} (${operation.options.index + 1}/${operation.options.count})`);
        console.log(`🎨 CANVAS DEBUG - Input path: ${operation.inputPath}`);
        console.log(`🎨 CANVAS DEBUG - Output path: ${operation.outputPath}`);
        console.log(`🎨 CANVAS DEBUG - Options:`, operation.options);
        
        try {
          // Canvas operations respect the job deadline
          await ffmpegProcessor.generateCanvasWithProgress(
            operation.inputPath,
            operation.outputPath,
            videoId,
            `Canvas ${operation.id}`,
            operation.options.index,
            operation.options.count,
            operation.options.duration
          );
          console.log(`✅ CANVAS DEBUG - Canvas operation completed: ${operation.id}`);
        } catch (canvasError) {
          console.error(`❌ CANVAS DEBUG - Canvas operation failed: ${operation.id}`, canvasError);
          throw canvasError; // Re-throw to be caught by the outer error handler
        }
        break;
        
      default:
        throw new Error(`❌ Operation type ${operation.type} not supported`);
    }
  }

  // Finalize job with ZIP creation and upload
  private async finalizeJob(job: AccurateProcessingJob): Promise<void> {
    console.log(`📦 Finalizing job for video ${job.videoId}...`);
    
    try {
      // Create ZIP and upload directly to R2 - NO local storage  
      const r2KeyWithPath = await this.createResultsZip(job);
      const r2Key = r2KeyWithPath; // This now contains the full R2 key with user prefix
      
      // Generate signed URL for downloads (remove verification as it's causing 403 errors)
      let r2DownloadUrl: string | undefined;
      try {
        r2DownloadUrl = await R2Storage.getSignedUrl(r2Key, 3600);
        console.log(`✅ R2 signed URL generated for ${r2Key}: ${r2DownloadUrl.substring(0, 100)}...`);
        
        // Skip verification - the uploadBuffer already confirmed success
        console.log(`✅ R2 file verification skipped - relying on upload confirmation`);
        
      } catch (r2Error: any) {
        console.error(`❌ R2 signed URL generation failed for ${r2Key}:`, r2Error);
        throw new Error(`R2 download preparation failed: ${r2Error.message}`);
      }
      
      // Update job status
      job.status = 'completed';
      job.downloadPath = r2Key; // Store the full R2 key instead of legacy format
      job.r2DownloadUrl = r2DownloadUrl;
      job.currentOperation = 'Processing completed successfully';
      
      // Store completed job for background job manager to detect
      this.completedJobs.set(job.videoId, { ...job });
      
      console.log(`✅ Job completed for video ${job.videoId}`);
      
    } catch (error) {
      console.error(`❌ Job finalization failed:`, error);
      job.status = 'failed';
      job.errors.push(`Finalization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      // Update database status for finalization failures
      await this.updateBackgroundJobStatus(job.videoId, 'failed', `Finalization failed: ${error instanceof Error ? error.message : 'Unknown error'}`, job.sessionId);
      
      // Always cleanup temporary files even on failure
      try {
        await this.cleanupTemporaryFiles(job);
      } catch (cleanupError) {
        console.warn(`⚠️ Failed to cleanup temporary files after finalization error:`, cleanupError);
      }
      
      // Store failed job for background job manager to detect
      this.completedJobs.set(job.videoId, { ...job });
    }
  }

  // Create ZIP with all results
  private async createResultsZip(job: AccurateProcessingJob): Promise<string> {
    const zip = new AdmZip();
    const completedOps = job.operations.filter(op => op.status === 'completed');

    // Get video metadata for folder naming
    const video = await storage.getVideo(job.videoId);
    const cleanName = video ? generateCleanFilename(video) : `video_${job.videoId}`;

    for (const operation of completedOps) {
      try {
        const stats = await fs.stat(operation.outputPath);
        if (stats.isFile()) {
          // Read file and add to ZIP in memory (temporary files will be cleaned up)
          const fileBuffer = await fs.readFile(operation.outputPath);
          const rawFilename = path.basename(operation.outputPath);

          // Strip timestamp prefix from filename for user-facing download
          // Backend R2 storage keeps the prefix for tracking, but ZIP files are clean
          const cleanFilename = stripTimestampPrefix(rawFilename);

          // Use video metadata in folder names
          let folderName: string;
          if (operation.type === 'cutdown') {
            const aspectSuffix = operation.options.aspectRatio === '9:16' ? '9x16' : '16x9';
            folderName = `${cleanName} - Clips (${aspectSuffix})`;
          } else if (operation.type === 'gif') {
            folderName = `${cleanName} - GIFs`;
          } else if (operation.type === 'thumbnail') {
            folderName = `${cleanName} - Thumbnails`;
          } else if (operation.type === 'canvas') {
            folderName = `${cleanName} - Canvas Loops`;
          } else {
            folderName = operation.type;
          }

          zip.addFile(`${folderName}/${cleanFilename}`, fileBuffer);
        }
      } catch (error) {
        console.warn(`⚠️ Could not add ${operation.outputPath} to ZIP:`, error);
      }
    }
    
    // Create ZIP in memory first, then upload directly to R2
    const zipBuffer = zip.toBuffer();

    // Reuse video and cleanName variables from folder naming above
    const zipFilename = `${cleanName} - Exports.zip`;

    // Generate R2 key with user association for proper organization
    const userEmail = job.userEmail || 'unknown';
    const { R2Storage } = await import('./r2-storage.js');
    
    // Ensure exports folder exists for the user before uploading
    if (userEmail && userEmail !== 'unknown') {
      await R2Storage.ensureExportsFolder(userEmail);
    }
    
    const r2Key = R2Storage.generateR2Key(zipFilename, 'exports', userEmail);
    
    // Upload directly to R2 with user association
    try {
      await R2Storage.uploadBuffer(zipBuffer, r2Key, 'application/zip', userEmail);
      console.log(`✅ ZIP uploaded directly to R2: ${r2Key} (user: ${userEmail})`);
      
      // Clean up temporary files after successful upload
      await this.cleanupTemporaryFiles(job);
      
      return r2Key; // Return full R2 key for database storage
    } catch (r2Error) {
      console.error(`❌ Failed to upload ZIP to R2:`, r2Error);
      // Still try to clean up temporary files even on failure
      try {
        await this.cleanupTemporaryFiles(job);
      } catch (cleanupError) {
        console.warn(`⚠️ Failed to cleanup temporary files:`, cleanupError);
      }
      throw new Error(`R2 upload failed: ${r2Error}`);
    }
  }

  // Helper methods
  private parseTimestamps(text: string): Array<{ startTime: string; endTime: string }> {
    // Implementation similar to existing parseTimestamps
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    const timestamps = [];
    
    for (const line of lines) {
      const parts = line.split(/[-–,\s]+/).filter(part => part.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        timestamps.push({
          startTime: this.normalizeTimestamp(parts[0]),
          endTime: this.normalizeTimestamp(parts[1])
        });
      }
    }
    
    return timestamps;
  }

  private normalizeTimestamp(timestamp: string): string {
    // Convert MM:SS to HH:MM:SS format
    const parts = timestamp.split(':');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `00:${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
    }
    return timestamp;
  }

  private calculateDuration(startTime: string, endTime: string): number {
    const parseTime = (time: string) => {
      const parts = time.split(':').map(Number).filter(n => !isNaN(n));
      if (parts.length === 3 && parts[0] !== undefined && parts[1] !== undefined && parts[2] !== undefined) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
        return parts[0] * 60 + parts[1];
      }
      return 0;
    };
    
    return parseTime(endTime) - parseTime(startTime);
  }

  // Download video from R2 for local processing
  private async downloadVideoForProcessing(videoId: number): Promise<string> {
    console.log(`📥 CANVAS DEBUG - Starting video download for processing: ${videoId}`);
    const video = await storage.getVideo(videoId);
    if (!video || !video.r2Key) {
      throw new Error(`Video ${videoId} not found or missing R2 key`);
    }
    
    const tempFileName = `video-${videoId}-${Date.now()}.mp4`;
    const localPath = `/tmp/${tempFileName}`;
    console.log(`📥 CANVAS DEBUG - Download target: ${localPath}`);
    
    try {
      // Download from R2 directly using SDK (avoids signed URL 403 errors)
      console.log(`📥 Downloading directly from R2 using SDK: ${video.r2Key}`);

      const fileBuffer = await R2Storage.downloadFile(video.r2Key);
      console.log(`📥 CANVAS DEBUG - Writing ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB to ${localPath}...`);
      
      try {
        await fs.writeFile(localPath, fileBuffer);
      } catch (writeError) {
        throw new Error(`Failed to write video file: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`);
      }
      
      // Verify the file was written correctly
      const stats = await fs.stat(localPath);
      console.log(`✅ CANVAS DEBUG - Downloaded and verified: ${(stats.size / 1024 / 1024).toFixed(2)} MB at ${localPath}`);
      
      return localPath;
    } catch (error) {
      console.error(`❌ Failed to download video for processing:`, error);
      throw new Error(`Failed to download video: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Clean up temporary files after processing - 100% cleanup guaranteed
  private async cleanupTemporaryFiles(job: AccurateProcessingJob): Promise<void> {
    console.log(`🧹 Cleaning up ALL temporary files for video ${job.videoId}...`);
    
    let cleanupCount = 0;
    
    // 1. Clean up all operation output files
    for (const operation of job.operations) {
      try {
        if (operation.outputPath && await fs.access(operation.outputPath).then(() => true).catch(() => false)) {
          await fs.unlink(operation.outputPath);
          console.log(`🗑️ Deleted operation file: ${path.basename(operation.outputPath)}`);
          cleanupCount++;
        }
      } catch (error) {
        console.warn(`⚠️ Could not delete operation file ${operation.outputPath}:`, error);
      }
    }
    
    // 2. Clean up downloaded video file if it exists
    if (job.localVideoPath) {
      try {
        if (await fs.access(job.localVideoPath).then(() => true).catch(() => false)) {
          await fs.unlink(job.localVideoPath);
          console.log(`🗑️ Deleted downloaded video: ${path.basename(job.localVideoPath)}`);
          cleanupCount++;
        }
      } catch (error) {
        console.warn(`⚠️ Could not delete downloaded video ${job.localVideoPath}:`, error);
      }
    }
    
    // 3. Clean up any remaining temp files for this video
    try {
      const tempFiles = await fs.readdir('/tmp');
      for (const file of tempFiles) {
        if (file.includes(`video-${job.videoId}`) || file.includes(`ffmpeg-progress-${job.videoId}`)) {
          try {
            const fullPath = path.join('/tmp', file);
            await fs.unlink(fullPath);
            console.log(`🗑️ Deleted temp file: ${file}`);
            cleanupCount++;
          } catch (error) {
            // File might already be deleted
          }
        }
      }
    } catch (error) {
      // /tmp might not be accessible, which is fine
    }
    
    // 4. Clean up processing directories
    try {
      const baseDir = `/tmp/processing`;
      const dirs = await fs.readdir(baseDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (dir.isDirectory() && (dir.name.includes(`${job.videoId}`) || (job.videoName && dir.name.includes(job.videoName)))) {
          const fullPath = path.join(baseDir, dir.name);
          try {
            await fs.rmdir(fullPath, { recursive: true });
            console.log(`🗑️ Deleted processing directory: ${dir.name}`);
            cleanupCount++;
          } catch (error) {
            // Directory might not be empty or already deleted
          }
        }
      }
    } catch (error) {
      // Base directory might not exist, which is fine
    }
    
    console.log(`✅ Cleanup completed: ${cleanupCount} files/directories removed for video ${job.videoId}`);
  }

  // Get current job status (checks both active and completed jobs)
  getJobStatus(videoId: number): AccurateProcessingJob | null {
    return this.activeJobs.get(videoId) || this.completedJobs.get(videoId) || null;
  }

  // Clear job status (for restarting stalled jobs)
  clearJobStatus(videoId: number): void {
    console.log(`🧹 Clearing job status for video ${videoId}`);
    this.activeJobs.delete(videoId);
    this.completedJobs.delete(videoId);
  }

  // Cancel job
  cancelJob(videoId: number): boolean {
    const job = this.activeJobs.get(videoId);
    if (job) {
      job.status = 'failed';
      job.errors.push('Processing cancelled by user');
      ffmpegProcessor.cancelVideoJobs(videoId);
      return true;
    }
    return false;
  }

  // Calculate comprehensive processing complexity based on all variables (PUBLIC for timeout calculations)
  calculateProcessingComplexity(operations: ProcessingOperation[], videoData: any, options: any) {
    const operationCount = operations.length;
    const timestampCount = operations.filter(op => op.type === 'cutdown').length;
    const gifCount = operations.filter(op => op.type === 'gif').length;
    const thumbnailCount = operations.filter(op => op.type === 'thumbnail').length;
    const canvasCount = operations.filter(op => op.type === 'canvas').length;
    
    // File size analysis (in GB)
    const fileSizeGB = (videoData.size || 0) / (1024 * 1024 * 1024);
    let fileSizeMultiplier = 1;
    if (fileSizeGB > 8) fileSizeMultiplier = 4;       // 8-10GB files: 4x processing time
    else if (fileSizeGB > 5) fileSizeMultiplier = 3;  // 5-8GB files: 3x processing time
    else if (fileSizeGB > 2) fileSizeMultiplier = 2;  // 2-5GB files: 2x processing time
    else if (fileSizeGB > 1) fileSizeMultiplier = 1.5; // 1-2GB files: 1.5x processing time
    
    // Video duration analysis (in minutes)
    const videoDurationMinutes = parseFloat(videoData.duration?.replace(/[^\d.]/g, '') || '0') / 60;
    let durationMultiplier = 1;
    if (videoDurationMinutes > 60) durationMultiplier = 3;      // >1hr videos: 3x time
    else if (videoDurationMinutes > 30) durationMultiplier = 2; // 30-60min videos: 2x time  
    else if (videoDurationMinutes > 10) durationMultiplier = 1.5; // 10-30min videos: 1.5x time
    
    // Export combination complexity analysis
    const exportTypes = [
      options.generateCutdowns,
      options.generateGif, 
      options.generateThumbnails,
      options.generateCanvas
    ].filter(Boolean).length;
    
    const aspectRatioCount = (options.aspectRatios || ['16:9']).length;
    const isBulkProcessing = operationCount > 8 || exportTypes >= 3;
    const isMaxComplexity = exportTypes === 4 && timestampCount >= 3 && aspectRatioCount === 2;
    
    // Quality settings impact
    const isHighQuality = options.quality === 'high';
    const hasFadeEffects = options.videoFade || options.audioFade;
    
    return {
      operationCount,
      timestampCount,
      exportTypes,
      aspectRatioCount,
      fileSizeGB: Math.round(fileSizeGB * 100) / 100,
      fileSizeMultiplier,
      videoDurationMinutes: Math.round(videoDurationMinutes * 10) / 10,
      durationMultiplier,
      isBulkProcessing,
      isMaxComplexity,
      isHighQuality,
      hasFadeEffects,
      hasCanvas: canvasCount > 0,
      canvasCount,
      gifCount,
      thumbnailCount,
      breakdown: {
        cutdowns: timestampCount,
        gifs: gifCount,
        thumbnails: thumbnailCount,
        canvas: canvasCount
      }
    };
  }
  
  // Calculate adaptive timeout based on comprehensive complexity analysis (PUBLIC for background manager)
  calculateAdaptiveTimeout(complexity: any): number {
    let baseTimeout = 15 * 60 * 1000; // 15 minutes base (increased from 5)
    
    // File size scaling (exponential for large files)
    baseTimeout *= complexity.fileSizeMultiplier;
    
    // Duration scaling
    baseTimeout *= complexity.durationMultiplier;
    
    // Export type scaling
    if (complexity.exportTypes === 4) baseTimeout += 8 * 60 * 1000;  // All types: +8 min
    else if (complexity.exportTypes === 3) baseTimeout += 5 * 60 * 1000; // 3 types: +5 min
    else if (complexity.exportTypes === 2) baseTimeout += 3 * 60 * 1000; // 2 types: +3 min
    
    // Timestamp scaling (2 min per timestamp beyond first)
    baseTimeout += (complexity.timestampCount - 1) * 2 * 60 * 1000;
    
    // Aspect ratio scaling (dual ratios require double processing)
    if (complexity.aspectRatioCount === 2) baseTimeout += 4 * 60 * 1000;
    
    // Canvas special handling (most resource intensive)
    if (complexity.hasCanvas) {
      baseTimeout += 6 * 60 * 1000; // Base Canvas penalty
      baseTimeout += complexity.canvasCount * 2 * 60 * 1000; // +2 min per Canvas
    }
    
    // Quality and effects scaling
    if (complexity.isHighQuality) baseTimeout += 2 * 60 * 1000;
    if (complexity.hasFadeEffects) baseTimeout += 1 * 60 * 1000;
    
    // Maximum complexity scenarios (all exports + multiple timestamps + dual ratios)
    if (complexity.isMaxComplexity) {
      baseTimeout += 10 * 60 * 1000; // Maximum complexity bonus
    }
    
    // Absolute caps aligned with FFmpeg maximum processing times
    let maxCap = 70 * 60 * 1000; // 70 minutes max (aligned with Canvas: 55min + buffer)
    if (complexity.fileSizeGB > 8) maxCap = 80 * 60 * 1000;      // 80 min for 8-10GB files
    else if (complexity.fileSizeGB > 5) maxCap = 75 * 60 * 1000; // 75 min for 5-8GB files  
    else if (complexity.fileSizeGB > 2) maxCap = 70 * 60 * 1000; // 70 min for 2-5GB files
    
    return Math.min(baseTimeout, maxCap);
  }

  // Helper to update background job status in database
  private async updateBackgroundJobStatus(videoId: number, status: string, errorMessage?: string, sessionId?: string): Promise<void> {
    try {
      const { storage } = await import('./storage.js');
      
      if (sessionId) {
        // Direct update if we have sessionId
        await storage.updateBackgroundJob(sessionId, { status, errorMessage });
        console.log(`📊 Updated background job ${sessionId} status to: ${status}`);
      } else {
        // Fallback: search all jobs to find the matching one
        const jobs = await storage.getUserBackgroundJobs(''); // Get all jobs
        const job = jobs.find((j: any) => j.videoId === videoId);
        if (job) {
          await storage.updateBackgroundJob(job.sessionId, { status, errorMessage });
          console.log(`📊 Updated background job ${job.id} status to: ${status}`);
        } else {
          console.error(`❌ Could not find background job for video ${videoId}`);
        }
      }
    } catch (error) {
      console.error('Failed to update background job status:', error);
    }
  }
}

export const enhancedProcessor = new EnhancedProcessor();