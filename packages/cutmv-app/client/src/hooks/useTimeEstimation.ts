/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Time Estimation Hook
 * Provides real-time processing time estimates with bulk scenario considerations
 */

import { useState, useCallback } from 'react';

interface TimeEstimateData {
  totalEstimatedSeconds: number;
  totalEstimatedDisplay: string;
  bulkProcessingDetected: boolean;
  warningMessages: string[];
  exportBreakdown: Array<{
    type: string;
    estimatedTimeDisplay: string;
    estimatedTimeSeconds: number;
    bulkMultiplier: number;
    qualityMultiplier: number;
  }>;
  complexity: {
    operationCount: number;
    exportTypes: number;
    fileSizeGB: number;
    videoDurationMinutes: number;
    isBulkProcessing: boolean;
    isMaxComplexity: boolean;
    breakdown: {
      cutdowns: number;
      gifs: number;
      thumbnails: number;
      canvas: number;
    };
  };
}

interface UseTimeEstimationOptions {
  onEstimateUpdate?: (estimate: TimeEstimateData) => void;
  onError?: (error: string) => void;
}

export function useTimeEstimation({ onEstimateUpdate, onError }: UseTimeEstimationOptions = {}) {
  const [estimate, setEstimate] = useState<TimeEstimateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const calculateEstimate = useCallback(async (
    processingOptions: any, 
    videoData: { size?: number; duration?: string; originalName?: string }
  ) => {
    if (!processingOptions || !videoData) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/estimate-processing-time', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          processingOptions,
          videoData
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to get time estimate');
      }

      const data = await response.json();
      
      if (data.success) {
        setEstimate(data.timeEstimate);
        onEstimateUpdate?.(data.timeEstimate);
      } else {
        throw new Error(data.error || 'Time estimation failed');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [onEstimateUpdate, onError]);

  // Calculate adjusted estimate based on real-time progress
  const adjustEstimateFromProgress = useCallback((
    currentProgressPercent: number,
    elapsedSeconds: number
  ): { adjustedEstimateSeconds: number; adjustedDisplay: string; speedIndicator: 'faster' | 'on-track' | 'slower' } | null => {
    if (!estimate || currentProgressPercent <= 0 || elapsedSeconds <= 0) {
      return null;
    }

    // Calculate actual processing rate
    const actualRate = currentProgressPercent / elapsedSeconds; // percent per second
    const remainingPercent = 100 - currentProgressPercent;
    const estimatedRemainingSeconds = remainingPercent / actualRate;

    const adjustedTotal = elapsedSeconds + estimatedRemainingSeconds;

    // Determine speed indicator
    const expectedProgressPercent = (elapsedSeconds / estimate.totalEstimatedSeconds) * 100;
    const deviation = currentProgressPercent - expectedProgressPercent;
    
    let speedIndicator: 'faster' | 'on-track' | 'slower' = 'on-track';
    if (currentProgressPercent > 5) { // Only calculate after 5% progress
      if (deviation > 15) {speedIndicator = 'faster';}
      else if (deviation < -15) {speedIndicator = 'slower';}
    }

    const formatDuration = (seconds: number): string => {
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
    };

    return {
      adjustedEstimateSeconds: Math.ceil(adjustedTotal),
      adjustedDisplay: formatDuration(estimatedRemainingSeconds),
      speedIndicator
    };
  }, [estimate]);

  // Get processing complexity indicators
  const getComplexityIndicators = useCallback(() => {
    if (!estimate) {return null;}

    const indicators = [];

    if (estimate.complexity.isBulkProcessing) {
      indicators.push('Bulk Processing');
    }

    if (estimate.complexity.fileSizeGB > 5) {
      indicators.push('Large File');
    }

    if (estimate.complexity.isMaxComplexity) {
      indicators.push('Maximum Complexity');
    }

    if (estimate.complexity.operationCount > 20) {
      indicators.push('High Operation Count');
    }

    if (estimate.bulkProcessingDetected) {
      indicators.push('Multi-Export');
    }

    return indicators;
  }, [estimate]);

  return {
    estimate,
    loading,
    error,
    calculateEstimate,
    adjustEstimateFromProgress,
    getComplexityIndicators,
    clearError: () => setError(null),
    clearEstimate: () => setEstimate(null)
  };
}