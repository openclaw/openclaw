/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Time Estimation Display Component
 * Shows accurate processing time estimates with bulk processing considerations
 */

import React, { useState, useEffect } from 'react';
import { Clock, AlertTriangle, Info, Zap, Timer } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

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

interface TimeEstimationDisplayProps {
  processingOptions: any;
  videoData: { size?: number; duration?: string; originalName?: string };
  onEstimateUpdate?: (estimate: TimeEstimateData) => void;
}

export default function TimeEstimationDisplay({ 
  processingOptions, 
  videoData, 
  onEstimateUpdate 
}: TimeEstimationDisplayProps) {
  const [estimate, setEstimate] = useState<TimeEstimateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch time estimate when options change
  useEffect(() => {
    if (processingOptions && videoData) {
      fetchTimeEstimate();
    }
  }, [processingOptions, videoData]);

  const fetchTimeEstimate = async () => {
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
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Timer className="w-4 h-4" />
            Calculating Processing Time...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-brand-green border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-600">Analyzing complexity...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          Unable to calculate processing time: {error}
        </AlertDescription>
      </Alert>
    );
  }

  if (!estimate) return null;

  const getExportTypeIcon = (type: string) => {
    switch (type) {
      case 'cutdown': return '🎬';
      case 'gif': return '🎞️';
      case 'thumbnail': return '📸';
      case 'canvas': return '🎨';
      default: return '⚙️';
    }
  };

  const getExportTypeName = (type: string) => {
    switch (type) {
      case 'cutdown': return 'Video Cutdowns';
      case 'gif': return 'GIF Pack';
      case 'thumbnail': return 'Thumbnails';
      case 'canvas': return 'Spotify Canvas';
      default: return type;
    }
  };

  return (
    <Card className="border-l-4 border-l-brand-green">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="w-4 h-4 text-brand-green" />
          Processing Time Estimate
          {estimate.bulkProcessingDetected && (
            <Badge variant="secondary" className="text-xs">
              <Zap className="w-3 h-3 mr-1" />
              Bulk Processing
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Estimated time based on file size, export options, and system load
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Total Time */}
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
          <span className="font-medium">Total Processing Time:</span>
          <span className="text-lg font-bold text-brand-green">
            {estimate.totalEstimatedDisplay}
          </span>
        </div>

        {/* File Complexity Info */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-600">File Size:</span>
            <span className="ml-2 font-medium">{estimate.complexity.fileSizeGB}GB</span>
          </div>
          <div>
            <span className="text-gray-600">Duration:</span>
            <span className="ml-2 font-medium">{estimate.complexity.videoDurationMinutes}min</span>
          </div>
          <div>
            <span className="text-gray-600">Export Types:</span>
            <span className="ml-2 font-medium">{estimate.complexity.exportTypes}</span>
          </div>
          <div>
            <span className="text-gray-600">Total Operations:</span>
            <span className="ml-2 font-medium">{estimate.complexity.operationCount}</span>
          </div>
        </div>

        {/* Export Breakdown */}
        {estimate.exportBreakdown.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-gray-700">Export Breakdown:</h4>
            {estimate.exportBreakdown.map((exportEst, index) => (
              <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                <div className="flex items-center gap-2">
                  <span>{getExportTypeIcon(exportEst.type)}</span>
                  <span className="text-sm">{getExportTypeName(exportEst.type)}</span>
                  {exportEst.bulkMultiplier > 1 && (
                    <Badge variant="outline" className="text-xs">
                      +{Math.round((exportEst.bulkMultiplier - 1) * 100)}% bulk
                    </Badge>
                  )}
                </div>
                <span className="text-sm font-medium">
                  {exportEst.estimatedTimeDisplay}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Complexity Indicators */}
        {estimate.complexity.isMaxComplexity && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              Maximum complexity detected: All export types with multiple timestamps and dual aspect ratios
            </AlertDescription>
          </Alert>
        )}

        {/* Warning Messages */}
        {estimate.warningMessages.length > 0 && (
          <div className="space-y-2">
            {estimate.warningMessages.map((warning, index) => (
              <Alert key={index} variant="default">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  {warning}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        {/* Processing Speed Note */}
        <div className="text-xs text-gray-500 bg-gray-50 p-2 rounded">
          <Info className="w-3 h-3 inline mr-1" />
          Estimates may vary based on server load and video complexity. 
          Actual processing includes intelligent optimization and automatic quality adjustments.
        </div>
      </CardContent>
    </Card>
  );
}