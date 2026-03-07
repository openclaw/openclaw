// Universal 100% Accurate Progress Tracking System
// Applies real-time FFmpeg streaming to ALL site operations

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export interface AccurateProgressData {
  operationType: 'upload' | 'download' | 'generation' | 'processing' | 'conversion' | 'compression';
  operationId: string;
  videoId?: number;
  progress: number; // 0-100
  stage: string;
  realTimeData?: {
    frame?: number;
    fps?: number;
    time?: string;
    speed?: string;
    bitrate?: string;
    size?: string;
    processingSpeed?: number; // vs real-time
  };
  estimatedTimeRemaining: number;
  startTime: number;
  currentBytes?: number;
  totalBytes?: number;
  status: 'initializing' | 'processing' | 'completed' | 'failed';
  errors: string[];
}

export interface OperationConfig {
  type: AccurateProgressData['operationType'];
  videoId?: number;
  totalDuration?: number;
  totalBytes?: number;
  expectedFrames?: number;
  websocketEnabled?: boolean;
}

class UniversalProgressTracker extends EventEmitter {
  private operations = new Map<string, AccurateProgressData>();
  private wsConnections = new Map<string, WebSocket[]>();
  private progressFiles = new Map<string, string>();

  // Register WebSocket for any operation type
  registerOperation(operationId: string, ws: WebSocket) {
    if (!this.wsConnections.has(operationId)) {
      this.wsConnections.set(operationId, []);
    }
    this.wsConnections.get(operationId)!.push(ws);

    ws.on('close', () => {
      const connections = this.wsConnections.get(operationId);
      if (connections) {
        const index = connections.indexOf(ws);
        if (index > -1) {
          connections.splice(index, 1);
        }
        if (connections.length === 0) {
          this.wsConnections.delete(operationId);
        }
      }
    });
  }

  // Broadcast progress to WebSocket clients
  private broadcastProgress(operationId: string, progressData: AccurateProgressData) {
    const connections = this.wsConnections.get(operationId);
    if (!connections || connections.length === 0) return;

    const message = JSON.stringify({
      type: 'accurate_progress',
      operationId,
      operationType: progressData.operationType,
      progress: progressData.progress,
      stage: progressData.stage,
      realTimeData: progressData.realTimeData,
      estimatedTimeRemaining: progressData.estimatedTimeRemaining,
      status: progressData.status,
      timestamp: Date.now(),
      accurateTracking: true,
    });

    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (error) {
          console.error('WebSocket broadcast error:', error);
        }
      }
    });
  }

  // Start tracking upload operation with real-time byte counting
  startUploadTracking(
    operationId: string, 
    config: OperationConfig & { totalBytes: number }
  ): void {
    const progressData: AccurateProgressData = {
      operationType: 'upload',
      operationId,
      videoId: config.videoId,
      progress: 0,
      stage: 'Initializing upload...',
      estimatedTimeRemaining: 0,
      startTime: Date.now(),
      currentBytes: 0,
      totalBytes: config.totalBytes,
      status: 'initializing',
      errors: [],
    };

    this.operations.set(operationId, progressData);
    
    if (config.websocketEnabled) {
      this.broadcastProgress(operationId, progressData);
    }

    console.log(`📊 Upload tracking started: ${operationId} (${this.formatBytes(config.totalBytes)})`);
  }

  // Update upload progress with real byte counts
  updateUploadProgress(
    operationId: string,
    currentBytes: number,
    stage?: string
  ): void {
    const operation = this.operations.get(operationId);
    if (!operation || operation.operationType !== 'upload') return;

    const progress = Math.min((currentBytes / (operation.totalBytes || 1)) * 100, 100);
    const elapsedTime = Date.now() - operation.startTime;
    const bytesPerMs = currentBytes / Math.max(elapsedTime, 1);
    const remainingBytes = (operation.totalBytes || 0) - currentBytes;
    const estimatedTimeRemaining = remainingBytes / Math.max(bytesPerMs, 0.001);

    operation.progress = progress;
    operation.currentBytes = currentBytes;
    operation.stage = stage || `Uploading... ${this.formatBytes(currentBytes)}/${this.formatBytes(operation.totalBytes || 0)}`;
    operation.estimatedTimeRemaining = estimatedTimeRemaining;
    operation.realTimeData = {
      processingSpeed: bytesPerMs * 1000, // bytes per second
    };

    if (progress >= 100) {
      operation.status = 'completed';
      operation.stage = 'Upload completed';
    }

    this.broadcastProgress(operationId, operation);
    
    console.log(`📈 Upload Progress: ${operationId} - ${progress.toFixed(1)}% (${this.formatBytes(currentBytes)})`);
  }

  // Start FFmpeg-based processing with real progress streaming
  async startFFmpegProcessing(
    operationId: string,
    config: OperationConfig & { 
      command: string[];
      totalDuration: number;
      expectedFrames?: number;
    }
  ): Promise<void> {
    const progressData: AccurateProgressData = {
      operationType: config.type,
      operationId,
      videoId: config.videoId,
      progress: 0,
      stage: 'Starting FFmpeg processing...',
      estimatedTimeRemaining: 0,
      startTime: Date.now(),
      status: 'processing',
      errors: [],
    };

    this.operations.set(operationId, progressData);

    const progressFile = `/tmp/progress-${operationId}.log`;
    this.progressFiles.set(operationId, progressFile);

    // Add progress reporting to FFmpeg command
    const ffmpegCmd = [
      '-progress', progressFile,
      '-nostats',
      ...config.command
    ];

    console.log(`🎬 Starting FFmpeg with real-time progress: ${operationId}`);
    console.log(`📊 Progress file: ${progressFile}`);

    return new Promise((resolve, reject) => {
      // Spawn FFmpeg process
      const ffmpegProcess = spawn('ffmpeg', ffmpegCmd);

      // Monitor progress file for real-time updates
      const progressInterval = setInterval(async () => {
        try {
          const progressContent = await fs.readFile(progressFile, 'utf8');
          const ffmpegProgress = this.parseFFmpegProgress(progressContent, config.totalDuration);
          
          if (ffmpegProgress) {
            progressData.progress = ffmpegProgress.progress;
            progressData.stage = `Processing... ${ffmpegProgress.time}/${config.totalDuration}s`;
            progressData.realTimeData = {
              frame: ffmpegProgress.frame,
              fps: ffmpegProgress.fps,
              time: ffmpegProgress.time,
              speed: ffmpegProgress.speed,
              bitrate: ffmpegProgress.bitrate,
              size: ffmpegProgress.size,
              processingSpeed: ffmpegProgress.processingSpeed,
            };
            progressData.estimatedTimeRemaining = ffmpegProgress.estimatedTimeRemaining;

            this.broadcastProgress(operationId, progressData);
            
            console.log(`🎬 ${config.type} Progress: ${operationId} - ${ffmpegProgress.progress.toFixed(1)}% (${ffmpegProgress.time}s) Speed: ${ffmpegProgress.speed}`);
          }
        } catch (error) {
          // Progress file might not exist yet, ignore
        }
      }, 200); // 200ms intervals for smooth updates

      ffmpegProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Error') || output.includes('failed')) {
          console.error(`FFmpeg stderr (${operationId}):`, output);
        }
      });

      ffmpegProcess.on('close', async (code) => {
        clearInterval(progressInterval);
        
        // Clean up progress file
        try {
          await fs.unlink(progressFile);
          this.progressFiles.delete(operationId);
        } catch (error) {
          // Ignore cleanup errors
        }

        if (code === 0) {
          progressData.progress = 100;
          progressData.status = 'completed';
          progressData.stage = `${config.type} completed successfully`;
          
          this.broadcastProgress(operationId, progressData);
          console.log(`✅ ${config.type} completed: ${operationId}`);
          resolve();
        } else {
          progressData.status = 'failed';
          progressData.errors.push(`FFmpeg process failed with code ${code}`);
          
          this.broadcastProgress(operationId, progressData);
          console.error(`❌ ${config.type} failed: ${operationId} (code: ${code})`);
          reject(new Error(`FFmpeg process failed with code ${code}`));
        }
      });

      ffmpegProcess.on('error', (error) => {
        clearInterval(progressInterval);
        progressData.status = 'failed';
        progressData.errors.push(error.message);
        
        this.broadcastProgress(operationId, progressData);
        console.error(`❌ ${config.type} process error:`, error);
        reject(error);
      });

      // Set adaptive timeout based on operation complexity
      const adaptiveTimeout = config.totalDuration ? 
        Math.max(config.totalDuration * 60000, 1800000) : // Use duration-based or minimum 30 minutes
        3600000; // 60 minutes for complex operations without duration
      
      setTimeout(() => {
        if (!ffmpegProcess.killed) {
          console.warn(`⏰ ${config.type} timeout after ${adaptiveTimeout/60000} minutes, killing process: ${operationId}`);
          ffmpegProcess.kill('SIGKILL');
          clearInterval(progressInterval);
          reject(new Error(`${config.type} timed out after ${adaptiveTimeout/60000} minutes`));
        }
      }, adaptiveTimeout);
    });
  }

  // Start download tracking with real-time byte monitoring
  startDownloadTracking(
    operationId: string,
    config: OperationConfig & { totalBytes?: number; downloadUrl: string }
  ): void {
    const progressData: AccurateProgressData = {
      operationType: 'download',
      operationId,
      videoId: config.videoId,
      progress: 0,
      stage: 'Preparing download...',
      estimatedTimeRemaining: 0,
      startTime: Date.now(),
      currentBytes: 0,
      totalBytes: config.totalBytes,
      status: 'initializing',
      errors: [],
    };

    this.operations.set(operationId, progressData);
    
    if (config.websocketEnabled) {
      this.broadcastProgress(operationId, progressData);
    }

    console.log(`📥 Download tracking started: ${operationId}`);
  }

  // Update download progress
  updateDownloadProgress(
    operationId: string,
    currentBytes: number,
    totalBytes?: number,
    stage?: string
  ): void {
    const operation = this.operations.get(operationId);
    if (!operation || operation.operationType !== 'download') return;

    const total = totalBytes || operation.totalBytes || currentBytes;
    const progress = Math.min((currentBytes / total) * 100, 100);
    const elapsedTime = Date.now() - operation.startTime;
    const bytesPerMs = currentBytes / Math.max(elapsedTime, 1);
    const remainingBytes = total - currentBytes;
    const estimatedTimeRemaining = remainingBytes / Math.max(bytesPerMs, 0.001);

    operation.progress = progress;
    operation.currentBytes = currentBytes;
    operation.totalBytes = total;
    operation.stage = stage || `Downloading... ${this.formatBytes(currentBytes)}/${this.formatBytes(total)}`;
    operation.estimatedTimeRemaining = estimatedTimeRemaining;
    operation.realTimeData = {
      processingSpeed: bytesPerMs * 1000, // bytes per second
    };

    if (progress >= 100) {
      operation.status = 'completed';
      operation.stage = 'Download completed';
    }

    this.broadcastProgress(operationId, operation);
  }

  // Parse real FFmpeg progress output
  private parseFFmpegProgress(progressContent: string, totalDurationSeconds: number): any {
    const lines = progressContent.trim().split('\n');
    const data: any = {};

    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key && value) {
        data[key.trim()] = value.trim();
      }
    }

    if (!data.out_time || data.out_time === 'N/A') {
      return null;
    }

    // Parse time in format HH:MM:SS.mmm
    const timeMatch = data.out_time.match(/(\d+):(\d+):(\d+)\.(\d+)/);
    if (!timeMatch) return null;

    const hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    const seconds = parseInt(timeMatch[3]);
    const milliseconds = parseInt(timeMatch[4]);
    
    const currentTimeSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
    const progress = Math.min((currentTimeSeconds / totalDurationSeconds) * 100, 100);

    // Calculate processing speed
    const processingSpeed = parseFloat(data.speed?.replace('x', '')) || 1;

    // Estimate time remaining
    const remainingSeconds = (totalDurationSeconds - currentTimeSeconds) / Math.max(processingSpeed, 0.1);

    return {
      frame: parseInt(data.frame) || 0,
      fps: parseFloat(data.fps) || 0,
      time: data.out_time || '00:00:00.00',
      speed: data.speed || '1x',
      bitrate: data.bitrate || '0kbits/s',
      size: data.total_size || '0kB',
      progress: Math.round(progress * 100) / 100,
      estimatedTimeRemaining: Math.round(remainingSeconds),
      processingSpeed: processingSpeed,
    };
  }

  // Get current operation status
  getOperationStatus(operationId: string): AccurateProgressData | null {
    return this.operations.get(operationId) || null;
  }

  // Cancel operation
  cancelOperation(operationId: string): boolean {
    const operation = this.operations.get(operationId);
    if (operation) {
      operation.status = 'failed';
      operation.errors.push('Operation cancelled by user');
      this.broadcastProgress(operationId, operation);
      
      // Clean up progress file if exists
      const progressFile = this.progressFiles.get(operationId);
      if (progressFile) {
        fs.unlink(progressFile).catch(() => {});
        this.progressFiles.delete(operationId);
      }
      
      return true;
    }
    return false;
  }

  // Utility function to format bytes
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Get all operations for a video
  getVideoOperations(videoId: number): AccurateProgressData[] {
    return Array.from(this.operations.values()).filter(op => op.videoId === videoId);
  }

  // Cleanup completed operations
  cleanupOldOperations(maxAge: number = 3600000): void {
    const cutoff = Date.now() - maxAge; // Default 1 hour
    
    for (const [operationId, operation] of Array.from(this.operations.entries())) {
      if (operation.startTime < cutoff && (operation.status === 'completed' || operation.status === 'failed')) {
        this.operations.delete(operationId);
        
        // Clean up progress file
        const progressFile = this.progressFiles.get(operationId);
        if (progressFile) {
          fs.unlink(progressFile).catch(() => {});
          this.progressFiles.delete(operationId);
        }
      }
    }
  }
}

// Global instance for universal progress tracking
export const universalProgress = new UniversalProgressTracker();

// Auto-cleanup every hour
setInterval(() => {
  universalProgress.cleanupOldOperations();
}, 3600000);