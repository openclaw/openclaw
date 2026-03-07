// Cloudflare Worker script for CUTMV video processing
// This would be deployed as a Cloudflare Worker to handle queue messages

export interface Env {
  // Cloudflare R2 bindings
  CUTMV_STORAGE: any; // R2Bucket type from @cloudflare/workers-types
  
  // Queue bindings
  CUTMV_PROCESSING_QUEUE: any; // Queue type from @cloudflare/workers-types
  
  // Durable Object for progress tracking (optional)
  PROGRESS_TRACKER: any; // DurableObjectNamespace type from @cloudflare/workers-types
  
  // Environment variables
  R2_BUCKET_NAME: string;
  WEBHOOK_URL?: string; // For progress updates back to main server
}

// Main queue consumer handler
export default {
  async queue(batch: any, env: Env, ctx: any): Promise<void> {
    for (const message of batch.messages) {
      try {
        const job = message.body;
        console.log(`🔄 Processing job ${job.jobId} for video ${job.videoId}`);
        
        // Acknowledge message immediately to prevent retries during processing
        message.ack();
        
        // Process the job asynchronously
        ctx.waitUntil(processVideoJob(job, env));
        
      } catch (error) {
        console.error(`❌ Failed to process queue message:`, error);
        // Let message retry by not calling ack()
        message.retry();
      }
    }
  }
};

// Core video processing function
async function processVideoJob(job: VideoProcessingJob, env: Env): Promise<void> {
  const startTime = Date.now();
  let totalItems = 0;
  let completedItems = 0;
  
  // Calculate total items for progress tracking
  if (job.processing.cutdowns) {
    totalItems += job.processing.cutdowns.timestamps.length * job.processing.cutdowns.aspectRatios.length;
  }
  if (job.processing.gifs) totalItems += job.processing.gifs.count;
  if (job.processing.thumbnails) totalItems += job.processing.thumbnails.count;
  if (job.processing.canvas) totalItems += job.processing.canvas.count;

  try {
    // Send initial progress update
    await sendProgressUpdate(job, {
      progress: 0,
      currentOperation: 'Starting video processing...',
      currentOperationProgress: 0,
      estimatedTimeRemaining: 0,
      processingSpeed: 0,
      status: 'processing',
      totalItems,
      currentItem: 0,
      operationStartTime: startTime,
      realTimeAccuracy: true,
    }, env);

    // Download source video from R2
    const sourceVideo = await env.CUTMV_STORAGE.get(job.inputUrl);
    if (!sourceVideo) {
      throw new Error(`Source video not found: ${job.inputUrl}`);
    }

    const sourceBuffer = await sourceVideo.arrayBuffer();
    
    // Process cutdowns if requested
    if (job.processing.cutdowns) {
      for (let i = 0; i < job.processing.cutdowns.timestamps.length; i++) {
        const timestamp = job.processing.cutdowns.timestamps[i];
        
        for (let j = 0; j < job.processing.cutdowns.aspectRatios.length; j++) {
          const aspectRatio = job.processing.cutdowns.aspectRatios[j];
          completedItems++;
          
          await sendProgressUpdate(job, {
            progress: Math.round((completedItems / totalItems) * 100),
            currentOperation: `Processing cutdown ${i + 1}/${job.processing.cutdowns.timestamps.length} (${aspectRatio})`,
            currentOperationProgress: Math.round((j + 1) / job.processing.cutdowns.aspectRatios.length * 100),
            estimatedTimeRemaining: calculateETA(startTime, completedItems, totalItems),
            processingSpeed: calculateSpeed(startTime, completedItems),
            status: 'processing',
            totalItems,
            currentItem: completedItems,
            operationStartTime: Date.now(),
            realTimeAccuracy: true,
          }, env);
          
          // Process cutdown using FFmpeg (via WASM or external API)
          const cutdownResult = await processCutdown(sourceBuffer, timestamp, aspectRatio, job.processing.cutdowns);
          
          // Upload result to R2
          const outputKey = `${job.jobId}/cutdowns/${aspectRatio}/${job.metadata.originalFilename}-clip-${String(i + 1).padStart(2, '0')}.mp4`;
          await env.CUTMV_STORAGE.put(outputKey, cutdownResult);
        }
      }
    }

    // Process GIFs if requested
    if (job.processing.gifs) {
      for (let i = 0; i < job.processing.gifs.count; i++) {
        completedItems++;
        
        await sendProgressUpdate(job, {
          progress: Math.round((completedItems / totalItems) * 100),
          currentOperation: `Generating GIF ${i + 1}/${job.processing.gifs.count}`,
          currentOperationProgress: Math.round((i + 1) / job.processing.gifs.count * 100),
          estimatedTimeRemaining: calculateETA(startTime, completedItems, totalItems),
          processingSpeed: calculateSpeed(startTime, completedItems),
          status: 'processing',
          totalItems,
          currentItem: completedItems,
          operationStartTime: Date.now(),
          realTimeAccuracy: true,
        }, env);
        
        // Process GIF
        const gifResult = await processGIF(sourceBuffer, job.processing.gifs, i);
        
        // Upload to R2
        const outputKey = `${job.jobId}/gifs/${job.metadata.originalFilename}-gif-${String(i + 1).padStart(2, '0')}.gif`;
        await env.CUTMV_STORAGE.put(outputKey, gifResult);
      }
    }

    // Process thumbnails if requested
    if (job.processing.thumbnails) {
      for (let i = 0; i < job.processing.thumbnails.count; i++) {
        completedItems++;
        
        await sendProgressUpdate(job, {
          progress: Math.round((completedItems / totalItems) * 100),
          currentOperation: `Generating thumbnail ${i + 1}/${job.processing.thumbnails.count}`,
          currentOperationProgress: Math.round((i + 1) / job.processing.thumbnails.count * 100),
          estimatedTimeRemaining: calculateETA(startTime, completedItems, totalItems),
          processingSpeed: calculateSpeed(startTime, completedItems),
          status: 'processing',
          totalItems,
          currentItem: completedItems,
          operationStartTime: Date.now(),
          realTimeAccuracy: true,
        }, env);
        
        // Process thumbnail
        const thumbnailResult = await processThumbnail(sourceBuffer, job.processing.thumbnails, i);
        
        // Upload to R2
        const outputKey = `${job.jobId}/thumbnails/${job.metadata.originalFilename}-thumbnail-${String(i + 1).padStart(2, '0')}.jpg`;
        await env.CUTMV_STORAGE.put(outputKey, thumbnailResult);
      }
    }

    // Process Canvas if requested
    if (job.processing.canvas) {
      for (let i = 0; i < job.processing.canvas.count; i++) {
        completedItems++;
        
        await sendProgressUpdate(job, {
          progress: Math.round((completedItems / totalItems) * 100),
          currentOperation: `Creating Spotify Canvas ${i + 1}/${job.processing.canvas.count}`,
          currentOperationProgress: Math.round((i + 1) / job.processing.canvas.count * 100),
          estimatedTimeRemaining: calculateETA(startTime, completedItems, totalItems),
          processingSpeed: calculateSpeed(startTime, completedItems),
          status: 'processing',
          totalItems,
          currentItem: completedItems,
          operationStartTime: Date.now(),
          realTimeAccuracy: true,
        }, env);
        
        // Process Canvas
        const canvasResult = await processCanvas(sourceBuffer, job.processing.canvas, i);
        
        // Upload to R2
        const outputKey = `${job.jobId}/canvas/${job.metadata.originalFilename}-canvas-${String(i + 1).padStart(2, '0')}.mp4`;
        await env.CUTMV_STORAGE.put(outputKey, canvasResult);
      }
    }

    // Create ZIP file with all results
    const zipKey = `${job.jobId}/${job.metadata.originalFilename}-exports.zip`;
    const zipFile = await createResultsZip(job, env);
    await env.CUTMV_STORAGE.put(zipKey, zipFile);

    // Generate presigned URL for download
    const downloadUrl = await env.CUTMV_STORAGE.get(zipKey, { range: { offset: 0, length: 1 } });
    
    // Send completion update
    await sendProgressUpdate(job, {
      progress: 100,
      currentOperation: 'Processing completed successfully',
      currentOperationProgress: 100,
      estimatedTimeRemaining: 0,
      processingSpeed: calculateSpeed(startTime, totalItems),
      status: 'completed',
      totalItems,
      currentItem: totalItems,
      downloadPath: `/api/download-r2/${zipKey}`,
      r2DownloadUrl: downloadUrl?.url,
      operationStartTime: startTime,
      realTimeAccuracy: true,
    }, env);

    console.log(`✅ Job ${job.jobId} completed successfully in ${Date.now() - startTime}ms`);

  } catch (error) {
    console.error(`❌ Job ${job.jobId} failed:`, error);
    
    await sendProgressUpdate(job, {
      progress: 0,
      currentOperation: 'Processing failed',
      currentOperationProgress: 0,
      estimatedTimeRemaining: 0,
      processingSpeed: 0,
      status: 'error',
      errors: [error instanceof Error ? error.message : 'Unknown error'],
      totalItems,
      currentItem: completedItems,
      operationStartTime: startTime,
      realTimeAccuracy: true,
    }, env);
  }
}

// Send progress update back to main server
async function sendProgressUpdate(job: VideoProcessingJob, update: Partial<QueueProgressUpdate>, env: Env): Promise<void> {
  if (!env.WEBHOOK_URL) return;

  const progressUpdate: QueueProgressUpdate = {
    jobId: job.jobId,
    videoId: job.videoId,
    progress: update.progress || 0,
    currentOperation: update.currentOperation || '',
    currentOperationProgress: update.currentOperationProgress || 0,
    estimatedTimeRemaining: update.estimatedTimeRemaining || 0,
    processingSpeed: update.processingSpeed || 0,
    status: update.status || 'processing',
    errors: update.errors,
    downloadPath: update.downloadPath,
    r2DownloadUrl: update.r2DownloadUrl,
    totalItems: update.totalItems || 0,
    currentItem: update.currentItem || 0,
    operationStartTime: update.operationStartTime,
    realTimeAccuracy: update.realTimeAccuracy || true,
  };

  try {
    await fetch(`${env.WEBHOOK_URL}/api/queue-progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(progressUpdate),
    });
  } catch (error) {
    console.error('Failed to send progress update:', error);
  }
}

// Helper functions for processing
async function processCutdown(sourceBuffer: ArrayBuffer, timestamp: any, aspectRatio: string, options: any): Promise<ArrayBuffer> {
  // Implementation would use FFmpeg WASM or external API
  // For now, return placeholder
  return new ArrayBuffer(1024);
}

async function processGIF(sourceBuffer: ArrayBuffer, options: any, index: number): Promise<ArrayBuffer> {
  // Implementation would use FFmpeg WASM or external API
  return new ArrayBuffer(1024);
}

async function processThumbnail(sourceBuffer: ArrayBuffer, options: any, index: number): Promise<ArrayBuffer> {
  // Implementation would use FFmpeg WASM or external API
  return new ArrayBuffer(1024);
}

async function processCanvas(sourceBuffer: ArrayBuffer, options: any, index: number): Promise<ArrayBuffer> {
  // For Canvas processing, we should use the enhanced processor instead of Cloudflare Worker
  // This is a fallback that shouldn't be used - Canvas processing should go through enhanced-process.ts
  throw new Error('Canvas processing should use enhanced processor, not Cloudflare Worker');
}

async function createResultsZip(job: VideoProcessingJob, env: Env): Promise<ArrayBuffer> {
  // Implementation would create ZIP from all generated files
  return new ArrayBuffer(1024);
}

function calculateETA(startTime: number, completed: number, total: number): number {
  if (completed === 0) return 0;
  const elapsed = Date.now() - startTime;
  const rate = completed / elapsed;
  return Math.round((total - completed) / rate);
}

function calculateSpeed(startTime: number, completed: number): number {
  const elapsed = Date.now() - startTime;
  return elapsed > 0 ? Math.round((completed / elapsed) * 1000 * 100) / 100 : 0;
}

// Type definitions for Cloudflare Worker environment
interface VideoProcessingJob {
  jobId: string;
  userId: string;
  videoId: number;
  inputUrl: string;
  outputBucket: string;
  processing: any;
  sessionId?: string;
  metadata: any;
}

interface QueueProgressUpdate {
  jobId: string;
  videoId: number;
  progress: number;
  currentOperation: string;
  currentOperationProgress: number;
  estimatedTimeRemaining: number;
  processingSpeed: number;
  status: 'processing' | 'completed' | 'error';
  errors?: string[];
  downloadPath?: string;
  r2DownloadUrl?: string;
  totalItems: number;
  currentItem: number;
  operationStartTime?: number;
  realTimeAccuracy: boolean;
}