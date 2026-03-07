import { useState, useEffect, useRef, useCallback } from 'react';

interface WebSocketProgressData {
  type: string;
  videoId: number;
  progress: number;
  currentOperation: string;
  currentOperationProgress: number;
  estimatedTimeRemaining: number;
  processingSpeed: number;
  status: 'processing' | 'completed' | 'error';
  errors: string[];
  downloadPath?: string;
  r2DownloadUrl?: string;
  totalItems: number;
  currentItem: number;
  operationStartTime?: number;
  totalDurationMs?: number;
  processedTimeMs?: number;
  realTimeAccuracy?: boolean;
  // Enhanced time estimation
  initialEstimateSeconds?: number;
  adjustedEstimateSeconds?: number;
  bulkProcessingDetected?: boolean;
  speedIndicator?: 'faster' | 'on-track' | 'slower';
  exportTypeEstimates?: Array<{
    type: string;
    estimatedTimeDisplay: string;
    completed: boolean;
  }>;
  // FFmpeg-specific real-time data
  ffmpegProgress?: {
    frame: number;
    fps: number;
    time: string;
    speed: string;
    bitrate: string;
    size: string;
    percentComplete: number;
  };
  // Queue-based processing indicators
  usingQueue?: boolean;
  queueJobId?: string;
  workerProgress?: {
    stage: 'downloading' | 'processing' | 'uploading' | 'completed';
    detail: string;
  };
}

interface UseWebSocketProgressOptions {
  videoId: number | null;
  onProgress?: (data: WebSocketProgressData) => void;
  onComplete?: (data: WebSocketProgressData) => void;
  onError?: (errors: string[]) => void;
}

export function useWebSocketProgress({
  videoId,
  onProgress,
  onComplete,
  onError
}: UseWebSocketProgressOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [progressData, setProgressData] = useState<WebSocketProgressData | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  const connect = useCallback(() => {
    if (!videoId || wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      
      console.log('🔌 Connecting to WebSocket for real-time progress:', wsUrl);
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('✅ WebSocket connected for video', videoId);
        setIsConnected(true);
        reconnectAttempts.current = 0;
        
        // Register for enhanced progress tracking (FFmpeg + Queue + Direct)
        ws.send(JSON.stringify({
          type: 'register',
          videoId,
          features: ['ffmpeg_progress', 'queue_progress', 'real_time_accuracy']
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data: WebSocketProgressData = JSON.parse(event.data);
          
          // Handle multiple message types for comprehensive progress tracking
          if ((data.type === 'progress' || data.type === 'ffmpeg_progress' || data.type === 'queue_progress') && data.videoId === videoId) {
            
            // Log real-time FFmpeg data for debugging
            if (data.ffmpegProgress) {
              console.log('🎬 Real-time FFmpeg Progress:', {
                frame: data.ffmpegProgress.frame,
                time: data.ffmpegProgress.time,
                speed: data.ffmpegProgress.speed,
                percent: data.ffmpegProgress.percentComplete,
                operation: data.currentOperation
              });
            }
            
            // Log queue worker progress
            if (data.usingQueue && data.workerProgress) {
              console.log('☁️ Cloudflare Worker Progress:', {
                stage: data.workerProgress.stage,
                detail: data.workerProgress.detail,
                jobId: data.queueJobId
              });
            }
            
            setProgressData(data);
            
            // Call appropriate callbacks
            if (data.status === 'completed' && onComplete) {
              onComplete(data);
            } else if (data.status === 'error' && onError) {
              onError(data.errors);
            } else if (onProgress) {
              onProgress(data);
            }
          }
        } catch (error) {
          console.error('WebSocket message parsing error:', error);
        }
      };

      ws.onclose = (event) => {
        console.log('🔌 WebSocket connection closed:', event.code, event.reason);
        setIsConnected(false);
        wsRef.current = null;
        
        // Attempt to reconnect if not intentionally closed
        if (event.code !== 1000 && reconnectAttempts.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000);
          console.log(`🔄 Attempting to reconnect in ${delay}ms (attempt ${reconnectAttempts.current + 1}/${maxReconnectAttempts})`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttempts.current++;
            connect();
          }, delay);
        }
      };

      ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        // Don't throw uncaught errors, handle gracefully
        setIsConnected(false);
      };

    } catch (error) {
      console.error('WebSocket connection failed:', error);
      setIsConnected(false);
    }
  }, [videoId, onProgress, onComplete, onError]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close(1000, 'Component unmounted');
      wsRef.current = null;
    }
    
    setIsConnected(false);
    setProgressData(null);
  }, []);

  // Connect when videoId changes
  useEffect(() => {
    if (videoId) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [videoId, connect, disconnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    isConnected,
    progressData,
    connect,
    disconnect
  };
}