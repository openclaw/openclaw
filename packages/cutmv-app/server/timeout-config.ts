/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Unified Timeout Configuration
 * Single source of truth for all processing timeouts
 * Updated: Fixed Canvas processing 'this' binding issue
 */

export interface JobDeadlineConfig {
  baseTimeMinutes: number;       // Base processing time (spin-up + IO)
  perMinuteFactor: number;       // Multiplier for video duration
  bufferPercentage: number;      // Safety buffer (e.g., 20%)
  maxCapMinutes: number;         // Absolute maximum timeout
  queueLeaseMinutes: number;     // Background job lease time
  heartbeatIntervalMinutes: number; // Heartbeat frequency
  graceMinutes: number;          // Grace period for cleanup
}

export interface StageTimeAllocation {
  forward: number;    // Percentage of total time for forward pass
  reverse: number;    // Percentage of total time for reverse pass
  concat: number;     // Percentage of total time for concatenation
  upload: number;     // Percentage of total time for R2 upload
}

export interface JobDeadline {
  startTime: Date;
  deadlineTime: Date;
  totalMinutes: number;
  videoDurationMinutes: number;
  complexity: {
    fileSizeGB: number;
    operationCount: number;
    exportTypes: string[];
    isBulkProcessing: boolean;
  };
}

// Central timeout configuration - single source of truth
export const TIMEOUT_CONFIG: JobDeadlineConfig = {
  baseTimeMinutes: 10,          // Increased base time for reliable processing
  perMinuteFactor: 3.0,         // Increased multiplier for complex operations (cutdowns + fade + aspect ratio)
  bufferPercentage: 50,         // Increased safety buffer for complex processing
  maxCapMinutes: 80,            // 80 minute absolute cap
  queueLeaseMinutes: 12,        // 12 minute queue lease
  heartbeatIntervalMinutes: 3,  // Extend lease every 3 minutes
  graceMinutes: 2,              // 2 minute cleanup grace period
};

// Stage time allocation percentages (must sum to ≤ 100%)
export const STAGE_ALLOCATION: StageTimeAllocation = {
  forward: 55,   // 55% for forward processing
  reverse: 30,   // 30% for reverse processing  
  concat: 10,    // 10% for concatenation
  upload: 5,     // 5% for upload/finalization
};

export class TimeoutManager {
  
  /**
   * Calculate job deadline based on video duration and complexity
   */
  static calculateJobDeadline(
    videoDurationSeconds: number,
    fileSizeGB: number,
    operationCount: number,
    exportTypes: string[]
  ): JobDeadline {
    const videoDurationMinutes = videoDurationSeconds / 60;
    const isBulkProcessing = operationCount > 8 || new Set(exportTypes).size > 2;
    
    // Apply formula: base + (duration * factor) * buffer
    let totalMinutes = TIMEOUT_CONFIG.baseTimeMinutes + 
                      (videoDurationMinutes * TIMEOUT_CONFIG.perMinuteFactor);
    
    // Apply buffer
    totalMinutes *= (1 + TIMEOUT_CONFIG.bufferPercentage / 100);
    
    // Complexity adjustments
    if (isBulkProcessing) totalMinutes *= 1.2; // 20% more for bulk
    if (fileSizeGB > 5) totalMinutes *= 1.1;   // 10% more for large files
    if (exportTypes.includes('canvas')) totalMinutes *= 1.15; // 15% more for Canvas
    
    // Apply absolute cap
    totalMinutes = Math.min(totalMinutes, TIMEOUT_CONFIG.maxCapMinutes);
    
    const startTime = new Date();
    const deadlineTime = new Date(startTime.getTime() + (totalMinutes * 60 * 1000));
    
    return {
      startTime,
      deadlineTime,
      totalMinutes,
      videoDurationMinutes,
      complexity: {
        fileSizeGB,
        operationCount,
        exportTypes,
        isBulkProcessing
      }
    };
  }
  
  /**
   * Calculate remaining time until deadline
   */
  static getTimeLeft(deadline: JobDeadline | null | undefined): number {
    if (!deadline || !deadline.deadlineTime) {
      console.warn('⚠️ getTimeLeft called with undefined deadline, returning 1 hour default');
      return 60 * 60 * 1000; // Return 1 hour in milliseconds as default
    }
    const now = new Date();
    const timeLeftMs = deadline.deadlineTime.getTime() - now.getTime();
    return Math.max(0, timeLeftMs);
  }
  
  /**
   * Get remaining time in minutes
   */
  static getTimeLeftMinutes(deadline: JobDeadline | null | undefined): number {
    if (!deadline || !deadline.deadlineTime) {
      console.warn('⚠️ getTimeLeftMinutes called with undefined deadline, returning 60 minutes default');
      return 60; // Return reasonable default
    }
    return this.getTimeLeft(deadline) / (60 * 1000);
  }
  
  /**
   * Check if deadline has been exceeded
   */
  static isDeadlineExceeded(deadline: JobDeadline): boolean {
    return this.getTimeLeft(deadline) <= 0;
  }
  
  /**
   * Calculate stage-specific time allocation
   */
  static getStageTimeAllocation(deadline: JobDeadline, stage: keyof StageTimeAllocation): number {
    const totalTimeMs = this.getTimeLeft(deadline);
    const percentage = STAGE_ALLOCATION[stage];
    return (totalTimeMs * percentage) / 100;
  }
  
  /**
   * Check if sufficient time remains for a stage
   */
  static hasSufficientTimeForStage(deadline: JobDeadline | null | undefined, stage: keyof StageTimeAllocation, estimatedMinutes: number): boolean {
    if (!deadline || !deadline.deadlineTime) {
      console.warn('⚠️ hasSufficientTimeForStage called with undefined deadline, returning true (allowing processing)');
      return true; // Allow processing if deadline is undefined
    }
    const allocatedTimeMs = this.getStageTimeAllocation(deadline, stage);
    const allocatedMinutes = allocatedTimeMs / (60 * 1000);
    return allocatedMinutes >= estimatedMinutes;
  }
  
  /**
   * Create a cancellation token that fires at deadline
   */
  static createCancellationToken(deadline: JobDeadline): {
    isCancelled: () => boolean;
    onCancel: (callback: () => void) => void;
    cancel: () => void;
  } {
    let cancelled = false;
    const callbacks: (() => void)[] = [];
    
    // Auto-cancel at deadline
    const timeLeft = this.getTimeLeft(deadline);
    if (timeLeft > 0) {
      setTimeout(() => {
        cancelled = true;
        callbacks.forEach(cb => cb());
      }, timeLeft);
    } else {
      cancelled = true;
    }
    
    return {
      isCancelled: () => cancelled,
      onCancel: (callback: () => void) => callbacks.push(callback),
      cancel: () => {
        cancelled = true;
        callbacks.forEach(cb => cb());
      }
    };
  }
  
  /**
   * Log deadline and timing information
   */
  static logDeadlineInfo(jobId: string, deadline: JobDeadline | null | undefined, stage?: string, estimated?: number, actual?: number): void {
    const timeLeft = TimeoutManager.getTimeLeftMinutes(deadline);
    const logData = {
      job_id: jobId,
      video_duration_min: deadline?.videoDurationMinutes?.toFixed(1) || 'unknown',
      total_deadline_min: deadline?.totalMinutes?.toFixed(1) || 'unknown',
      time_left_min: timeLeft.toFixed(1),
      complexity: deadline?.complexity || 'unknown',
      ...(stage && { stage }),
      ...(estimated && { stage_estimate_min: estimated.toFixed(1) }),
      ...(actual && { stage_actual_min: actual.toFixed(1) }),
      ...(estimated && actual && { 
        efficiency: (actual / estimated).toFixed(2)
      })
    };
    
    console.log(`⏱️ DEADLINE INFO:`, JSON.stringify(logData, null, 2));
  }
}

// Export commonly used functions with proper binding
export const calculateJobDeadline = (...args: Parameters<typeof TimeoutManager.calculateJobDeadline>) =>
  TimeoutManager.calculateJobDeadline(...args);

export const getTimeLeft = (...args: Parameters<typeof TimeoutManager.getTimeLeft>) =>
  TimeoutManager.getTimeLeft(...args);

export const getTimeLeftMinutes = (...args: Parameters<typeof TimeoutManager.getTimeLeftMinutes>) =>
  TimeoutManager.getTimeLeftMinutes(...args);

export const isDeadlineExceeded = (...args: Parameters<typeof TimeoutManager.isDeadlineExceeded>) =>
  TimeoutManager.isDeadlineExceeded(...args);

export const getStageTimeAllocation = (...args: Parameters<typeof TimeoutManager.getStageTimeAllocation>) =>
  TimeoutManager.getStageTimeAllocation(...args);

export const hasSufficientTimeForStage = (...args: Parameters<typeof TimeoutManager.hasSufficientTimeForStage>) =>
  TimeoutManager.hasSufficientTimeForStage(...args);

export const createCancellationToken = (...args: Parameters<typeof TimeoutManager.createCancellationToken>) =>
  TimeoutManager.createCancellationToken(...args);

export const logDeadlineInfo = (...args: Parameters<typeof TimeoutManager.logDeadlineInfo>) =>
  TimeoutManager.logDeadlineInfo(...args);