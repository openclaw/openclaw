/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Comprehensive Time Estimation System
 * Accurate processing time predictions for all export options
 */

export interface ProcessingComplexity {
  operationCount: number;
  timestampCount: number;
  exportTypes: number;
  aspectRatioCount: number;
  fileSizeGB: number;
  fileSizeMultiplier: number;
  videoDurationMinutes: number;
  durationMultiplier: number;
  isBulkProcessing: boolean;
  isMaxComplexity: boolean;
  isHighQuality: boolean;
  hasFadeEffects: boolean;
  hasCanvas: boolean;
  canvasCount: number;
  gifCount: number;
  thumbnailCount: number;
  breakdown: {
    cutdowns: number;
    gifs: number;
    thumbnails: number;
    canvas: number;
  };
}

export interface ExportTypeEstimate {
  type: 'cutdown' | 'gif' | 'thumbnail' | 'canvas';
  baseTimeSeconds: number;
  perItemSeconds: number;
  bulkMultiplier: number;
  qualityMultiplier: number;
  sizeMultiplier: number;
  estimatedTimeSeconds: number;
  estimatedTimeDisplay: string;
}

export interface TimeEstimateResult {
  totalEstimatedSeconds: number;
  totalEstimatedDisplay: string;
  exportEstimates: ExportTypeEstimate[];
  complexity: ProcessingComplexity;
  bulkProcessingDetected: boolean;
  warningMessages: string[];
}

export class TimeEstimationService {
  
  // Base processing times per export type (in seconds)
  private static readonly BASE_TIMES = {
    cutdown: 15,    // 15 seconds per cutdown clip
    gif: 25,        // 25 seconds per GIF generation
    thumbnail: 8,   // 8 seconds per thumbnail
    canvas: 45,     // 45 seconds per Canvas (most complex)
  };

  // Bulk processing multipliers when multiple export types are selected
  private static readonly BULK_MULTIPLIERS = {
    cutdown: 1.2,   // 20% increase in bulk
    gif: 1.5,       // 50% increase (more memory intensive)
    thumbnail: 1.1, // 10% increase (lightweight)
    canvas: 1.8,    // 80% increase (most affected by bulk)
  };

  // File size impact on processing speed
  private static readonly SIZE_MULTIPLIERS = {
    small: 1.0,     // <1GB
    medium: 1.5,    // 1-2GB
    large: 2.2,     // 2-5GB
    huge: 3.5,      // 5-8GB
    massive: 5.0,   // 8-10GB
  };

  static calculateProcessingComplexity(
    options: any, 
    videoData: { size?: number; duration?: string }
  ): ProcessingComplexity {
    const fileSizeGB = (videoData.size || 0) / (1024 * 1024 * 1024);
    const videoDurationMinutes = parseFloat(videoData.duration?.replace(/[^\d.]/g, '') || '0') / 60;
    
    // Count operations
    const timestamps = options.timestampText ? 
      options.timestampText.split('\n').filter((line: string) => line.trim()).length : 1;
    const aspectRatios = (options.aspectRatios || ['16:9']).length;
    
    const cutdownCount = options.generateCutdowns ? timestamps * aspectRatios : 0;
    const gifCount = options.generateGif ? timestamps : 0;
    const thumbnailCount = options.generateThumbnails ? timestamps : 0;
    const canvasCount = options.generateCanvas ? timestamps : 0;
    
    const totalOperations = cutdownCount + gifCount + thumbnailCount + canvasCount;
    
    // Export types selected
    const exportTypes = [
      options.generateCutdowns,
      options.generateGif,
      options.generateThumbnails,
      options.generateCanvas
    ].filter(Boolean).length;

    // Calculate multipliers
    let fileSizeMultiplier = 1;
    if (fileSizeGB > 8) {fileSizeMultiplier = 5;}
    else if (fileSizeGB > 5) {fileSizeMultiplier = 3.5;}
    else if (fileSizeGB > 2) {fileSizeMultiplier = 2.2;}
    else if (fileSizeGB > 1) {fileSizeMultiplier = 1.5;}

    let durationMultiplier = 1;
    if (videoDurationMinutes > 60) {durationMultiplier = 3;}
    else if (videoDurationMinutes > 30) {durationMultiplier = 2;}
    else if (videoDurationMinutes > 10) {durationMultiplier = 1.5;}

    const isBulkProcessing = totalOperations > 8 || exportTypes >= 3;
    const isMaxComplexity = exportTypes === 4 && timestamps >= 3 && aspectRatios === 2;

    return {
      operationCount: totalOperations,
      timestampCount: timestamps,
      exportTypes,
      aspectRatioCount: aspectRatios,
      fileSizeGB: Math.round(fileSizeGB * 100) / 100,
      fileSizeMultiplier,
      videoDurationMinutes: Math.round(videoDurationMinutes * 10) / 10,
      durationMultiplier,
      isBulkProcessing,
      isMaxComplexity,
      isHighQuality: options.quality === 'high',
      hasFadeEffects: options.videoFade || options.audioFade,
      hasCanvas: canvasCount > 0,
      canvasCount,
      gifCount,
      thumbnailCount,
      breakdown: {
        cutdowns: cutdownCount,
        gifs: gifCount,
        thumbnails: thumbnailCount,
        canvas: canvasCount
      }
    };
  }

  static estimateProcessingTime(complexity: ProcessingComplexity): TimeEstimateResult {
    const estimates: ExportTypeEstimate[] = [];
    let totalSeconds = 0;
    const warnings: string[] = [];

    // Calculate estimates for each export type
    if (complexity.breakdown.cutdowns > 0) {
      const estimate = this.calculateExportTypeEstimate(
        'cutdown', 
        complexity.breakdown.cutdowns, 
        complexity
      );
      estimates.push(estimate);
      totalSeconds += estimate.estimatedTimeSeconds;
    }

    if (complexity.breakdown.gifs > 0) {
      const estimate = this.calculateExportTypeEstimate(
        'gif', 
        complexity.breakdown.gifs, 
        complexity
      );
      estimates.push(estimate);
      totalSeconds += estimate.estimatedTimeSeconds;
    }

    if (complexity.breakdown.thumbnails > 0) {
      const estimate = this.calculateExportTypeEstimate(
        'thumbnail', 
        complexity.breakdown.thumbnails, 
        complexity
      );
      estimates.push(estimate);
      totalSeconds += estimate.estimatedTimeSeconds;
    }

    if (complexity.breakdown.canvas > 0) {
      const estimate = this.calculateExportTypeEstimate(
        'canvas', 
        complexity.breakdown.canvas, 
        complexity
      );
      estimates.push(estimate);
      totalSeconds += estimate.estimatedTimeSeconds;
    }

    // Add bulk processing overhead
    if (complexity.isBulkProcessing) {
      const bulkOverhead = totalSeconds * 0.2; // 20% overhead for bulk
      totalSeconds += bulkOverhead;
      warnings.push('Bulk processing detected - additional coordination time included');
    }

    // Add warnings for complex scenarios
    if (complexity.fileSizeGB > 5) {
      warnings.push(`Large file (${complexity.fileSizeGB}GB) will require extended processing time`);
    }

    if (complexity.isMaxComplexity) {
      warnings.push('Maximum complexity scenario - all export types with multiple timestamps');
      totalSeconds += 120; // 2 minutes additional overhead
    }

    if (complexity.operationCount > 20) {
      warnings.push(`Processing ${complexity.operationCount} individual files simultaneously`);
    }

    return {
      totalEstimatedSeconds: Math.ceil(totalSeconds),
      totalEstimatedDisplay: this.formatDuration(totalSeconds),
      exportEstimates: estimates,
      complexity,
      bulkProcessingDetected: complexity.isBulkProcessing,
      warningMessages: warnings
    };
  }

  private static calculateExportTypeEstimate(
    type: 'cutdown' | 'gif' | 'thumbnail' | 'canvas',
    count: number,
    complexity: ProcessingComplexity
  ): ExportTypeEstimate {
    const baseTime = this.BASE_TIMES[type];
    let perItemTime = baseTime;

    // Apply file size multiplier
    perItemTime *= complexity.fileSizeMultiplier;

    // Apply duration multiplier
    perItemTime *= complexity.durationMultiplier;

    // Apply quality multiplier
    const qualityMultiplier = complexity.isHighQuality ? 1.3 : 1.0;
    perItemTime *= qualityMultiplier;

    // Apply bulk processing multiplier
    const bulkMultiplier = complexity.isBulkProcessing ? this.BULK_MULTIPLIERS[type] : 1.0;
    perItemTime *= bulkMultiplier;

    // Apply fade effects penalty
    if (complexity.hasFadeEffects && (type === 'cutdown' || type === 'canvas')) {
      perItemTime *= 1.1; // 10% increase for fade processing
    }

    // Special Canvas penalties for aspect ratio processing
    if (type === 'canvas' && complexity.aspectRatioCount === 2) {
      perItemTime *= 1.4; // 40% increase for dual aspect ratios
    }

    // Special GIF penalties for high frame rates
    if (type === 'gif' && complexity.videoDurationMinutes > 20) {
      perItemTime *= 1.2; // 20% increase for long videos
    }

    const totalTime = perItemTime * count;

    return {
      type,
      baseTimeSeconds: baseTime,
      perItemSeconds: perItemTime,
      bulkMultiplier,
      qualityMultiplier,
      sizeMultiplier: complexity.fileSizeMultiplier,
      estimatedTimeSeconds: Math.ceil(totalTime),
      estimatedTimeDisplay: this.formatDuration(totalTime)
    };
  }

  static formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${Math.ceil(seconds)}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.ceil(seconds % 60);
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
  }

  // Real-time progress adjustment based on actual processing speed
  static adjustEstimateFromProgress(
    originalEstimateSeconds: number,
    currentProgressPercent: number,
    elapsedSeconds: number
  ): { adjustedEstimateSeconds: number; adjustedDisplay: string } {
    if (currentProgressPercent <= 0 || elapsedSeconds <= 0) {
      return {
        adjustedEstimateSeconds: originalEstimateSeconds,
        adjustedDisplay: this.formatDuration(originalEstimateSeconds)
      };
    }

    // Calculate actual processing rate
    const actualRate = currentProgressPercent / elapsedSeconds; // percent per second
    const remainingPercent = 100 - currentProgressPercent;
    const estimatedRemainingSeconds = remainingPercent / actualRate;

    const adjustedTotal = elapsedSeconds + estimatedRemainingSeconds;

    return {
      adjustedEstimateSeconds: Math.ceil(adjustedTotal),
      adjustedDisplay: this.formatDuration(estimatedRemainingSeconds)
    };
  }

  // Get processing speed indicator
  static getProcessingSpeedIndicator(
    estimatedSeconds: number,
    actualElapsedSeconds: number,
    progressPercent: number
  ): 'faster' | 'on-track' | 'slower' {
    if (progressPercent <= 5) {return 'on-track';} // Too early to tell

    const expectedProgressPercent = (actualElapsedSeconds / estimatedSeconds) * 100;
    const deviation = progressPercent - expectedProgressPercent;

    if (deviation > 15) {return 'faster';}
    if (deviation < -15) {return 'slower';}
    return 'on-track';
  }
}