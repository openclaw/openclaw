// Cloudflare Queues integration for CUTMV video processing
// Replaces in-memory processing with scalable, durable queue system

import { WebSocket } from 'ws';

// Queue message interface for video processing jobs
export interface VideoProcessingJob {
  jobId: string;
  userId: string;
  videoId: number;
  inputUrl: string; // R2 URL for source video
  outputBucket: string; // R2 bucket for results
  processing: {
    cutdowns?: {
      timestamps: Array<{ startTime: string; endTime: string }>;
      aspectRatios: string[];
      quality: string;
      videoFade?: boolean;
      audioFade?: boolean;
      fadeDuration?: number;
    };
    gifs?: {
      count: number;
      duration: number;
      quality: string;
    };
    thumbnails?: {
      count: number;
      quality: string;
    };
    canvas?: {
      count: number;
      duration: number;
    };
  };
  sessionId?: string;
  metadata: {
    originalFilename: string;
    duration: number;
    createdAt: number;
  };
}

// Progress update interface for queue communication
export interface QueueProgressUpdate {
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

// Cloudflare Queue client for CUTMV
export class CloudflareQueueManager {
  private queueName: string;
  private accountId: string;
  private apiToken: string;
  private wsConnections: Map<number, WebSocket[]> = new Map();

  constructor() {
    this.queueName = process.env.CLOUDFLARE_QUEUE_NAME || 'cutmv-processing';
    this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
    this.apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
    
    if (!this.accountId || !this.apiToken) {
      console.warn('⚠️ Cloudflare Queues not configured - falling back to direct processing');
    }
  }

  // Enqueue video processing job to Cloudflare Queues
  async enqueueProcessingJob(job: VideoProcessingJob): Promise<{ success: boolean; jobId: string; message?: string }> {
    try {
      if (!this.accountId || !this.apiToken) {
        console.log('📝 Cloudflare Queues not configured, processing directly');
        return { success: false, jobId: job.jobId, message: 'Queue not configured' };
      }

      const queueUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/queues/${this.queueName}/messages`;
      
      const response = await fetch(queueUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{
            body: JSON.stringify(job),
            id: job.jobId,
            timestamp: Date.now(),
          }]
        })
      });

      const result = await response.json();
      
      if (!response.ok) {
        console.error('❌ Cloudflare Queue enqueue failed:', result);
        return { success: false, jobId: job.jobId, message: result.errors?.[0]?.message || 'Queue submission failed' };
      }

      console.log(`✅ Job ${job.jobId} enqueued to Cloudflare Queue successfully`);
      return { success: true, jobId: job.jobId };

    } catch (error) {
      console.error('❌ Queue enqueue error:', error);
      return { success: false, jobId: job.jobId, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Register WebSocket connection for progress updates
  registerWebSocket(videoId: number, ws: WebSocket) {
    if (!this.wsConnections.has(videoId)) {
      this.wsConnections.set(videoId, []);
    }
    this.wsConnections.get(videoId)!.push(ws);

    // Remove on close
    ws.on('close', () => {
      const connections = this.wsConnections.get(videoId);
      if (connections) {
        const index = connections.indexOf(ws);
        if (index > -1) {
          connections.splice(index, 1);
        }
        if (connections.length === 0) {
          this.wsConnections.delete(videoId);
        }
      }
    });

    console.log(`🔌 WebSocket registered for video ${videoId} (${this.wsConnections.get(videoId)?.length} total connections)`);
  }

  // Broadcast progress update to connected WebSockets
  broadcastProgress(update: QueueProgressUpdate) {
    const connections = this.wsConnections.get(update.videoId);
    if (!connections || connections.length === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'progress',
      ...update
    });

    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (error) {
          console.error('WebSocket send error:', error);
        }
      }
    });
  }

  // Process progress update from Cloudflare Worker or Durable Object
  async handleProgressUpdate(update: QueueProgressUpdate) {
    // Broadcast to connected WebSockets immediately
    this.broadcastProgress(update);

    // Store progress in database or cache if needed
    console.log(`📊 Progress update: Video ${update.videoId} - ${update.currentOperation} (${update.progress}%)`);
  }

  // Create job from processing request
  createProcessingJob(
    videoId: number,
    inputUrl: string,
    timestampText: string,
    options: {
      generateCutdowns?: boolean;
      generateGif?: boolean;
      generateThumbnails?: boolean;
      generateCanvas?: boolean;
      aspectRatios?: string[];
      quality?: string;
      videoFade?: boolean;
      audioFade?: boolean;
      fadeDuration?: number;
      sessionId?: string;
      originalFilename?: string;
      duration?: number;
    }
  ): VideoProcessingJob {
    const jobId = `cutmv_${videoId}_${Date.now()}`;
    
    // Parse timestamps for cutdowns
    const timestamps = options.generateCutdowns ? this.parseTimestamps(timestampText) : [];
    
    const job: VideoProcessingJob = {
      jobId,
      userId: options.sessionId || 'anonymous',
      videoId,
      inputUrl,
      outputBucket: process.env.R2_BUCKET_NAME || 'cutmv-storage',
      processing: {},
      sessionId: options.sessionId,
      metadata: {
        originalFilename: options.originalFilename || `video_${videoId}`,
        duration: options.duration || 0,
        createdAt: Date.now(),
      }
    };

    // Add cutdowns processing if enabled
    if (options.generateCutdowns && timestamps.length > 0) {
      job.processing.cutdowns = {
        timestamps,
        aspectRatios: options.aspectRatios || ['16:9'],
        quality: options.quality || 'balanced',
        videoFade: options.videoFade,
        audioFade: options.audioFade,
        fadeDuration: options.fadeDuration,
      };
    }

    // Add GIF processing if enabled
    if (options.generateGif) {
      const isShortVideo = (options.duration || 0) < 40;
      job.processing.gifs = {
        count: isShortVideo ? 5 : 10,
        duration: 6,
        quality: options.quality || 'balanced',
      };
    }

    // Add thumbnail processing if enabled
    if (options.generateThumbnails) {
      const isShortVideo = (options.duration || 0) < 40;
      job.processing.thumbnails = {
        count: isShortVideo ? 5 : 10,
        quality: options.quality || 'balanced',
      };
    }

    // Add Canvas processing if enabled
    if (options.generateCanvas) {
      const isShortVideo = (options.duration || 0) < 40;
      job.processing.canvas = {
        count: isShortVideo ? 2 : 5,
        duration: 8,
      };
    }

    return job;
  }

  // Parse timestamps from text input
  private parseTimestamps(text: string): Array<{ startTime: string; endTime: string }> {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    const timestamps = [];
    
    for (const line of lines) {
      const rangeSeparators = /[-–,\s]+/;
      const parts = line.split(rangeSeparators).filter(part => part.trim());
      
      if (parts.length >= 2) {
        const startTime = this.normalizeTimestamp(parts[0].trim());
        const endTime = this.normalizeTimestamp(parts[1].trim());
        
        if (startTime && endTime) {
          timestamps.push({ startTime, endTime });
        }
      }
    }
    
    return timestamps;
  }

  // Normalize timestamp format
  private normalizeTimestamp(timestamp: string): string | null {
    // Remove any extra whitespace and handle various formats
    const cleaned = timestamp.trim();
    
    // Match MM:SS or HH:MM:SS format
    const timeRegex = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
    const match = cleaned.match(timeRegex);
    
    if (!match) return null;
    
    const [, minutes, seconds, extraSeconds] = match;
    
    if (extraSeconds !== undefined) {
      // Already in HH:MM:SS format, validate
      const hrs = parseInt(minutes);
      const mins = parseInt(seconds);
      const secs = parseInt(extraSeconds);
      
      if (hrs >= 0 && mins < 60 && secs < 60) {
        return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
    } else {
      // MM:SS format, convert to HH:MM:SS
      const mins = parseInt(minutes);
      const secs = parseInt(seconds);
      
      if (mins >= 0 && secs < 60) {
        const hours = Math.floor(mins / 60);
        const remainingMins = mins % 60;
        return `${hours.toString().padStart(2, '0')}:${remainingMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
    }
    
    return null;
  }

  // Get queue status and health
  async getQueueStatus(): Promise<{ healthy: boolean; message: string; configured: boolean }> {
    if (!this.accountId || !this.apiToken) {
      return { 
        healthy: false, 
        message: 'Cloudflare Queues not configured - using direct processing', 
        configured: false 
      };
    }

    try {
      const queueUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/queues/${this.queueName}`;
      
      const response = await fetch(queueUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        }
      });

      const result = await response.json();

      if (response.ok) {
        return { 
          healthy: true, 
          message: `Queue '${this.queueName}' is operational`, 
          configured: true 
        };
      } else {
        return { 
          healthy: false, 
          message: result.errors?.[0]?.message || 'Queue status check failed', 
          configured: true 
        };
      }

    } catch (error) {
      return { 
        healthy: false, 
        message: error instanceof Error ? error.message : 'Queue connection failed', 
        configured: true 
      };
    }
  }
}

// Global queue manager instance
export const queueManager = new CloudflareQueueManager();