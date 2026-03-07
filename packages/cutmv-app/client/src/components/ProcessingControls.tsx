import { useState, useEffect, useRef } from "react";
import { Download, Loader2, CheckCircle, Clock, Scissors, ImageIcon, Volume2, FileImage, Image, Wifi, WifiOff, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWebSocketProgress } from "@/hooks/useWebSocketProgress";
import { useTimeEstimation } from "@/hooks/useTimeEstimation";
import TimeEstimationDisplay from "@/components/TimeEstimationDisplay";
import { logUserEvent } from "@/lib/sentry";
import type { Video, Timestamp } from "@shared/schema";

interface ProcessingControlsProps {
  video: Video | null;
  timestampText: string;
  onProcessingComplete: (downloadPath?: string, r2DownloadUrl?: string) => void;
  generateCutdowns?: boolean;
  generateGif?: boolean;
  generateThumbnails?: boolean;
  generateCanvas?: boolean;
  aspectRatios?: ('16:9' | '9:16')[];
  onAspectRatiosChange?: (ratios: ('16:9' | '9:16')[]) => void;
  sessionId?: string;
  // Removed watermark functionality - CUTMV is now paid-only with clean exports
}

interface ProcessingStatus {
  isProcessing: boolean;
  progress: number;
  currentClip: number;
  totalClips: number;
  totalGifs?: number;
  totalThumbnails?: number;
  totalCanvas?: number;
  totalOutputs?: number;
  processedClips: string[];
  errors: string[];
  downloadPath?: string;
  startTime?: number;
  estimatedTimeLeft?: number;
  canCancel: boolean;
  stage: 'preparing' | 'processing' | 'generating' | 'finalizing' | 'completed';
  simulatedProgress: number;
  simulatedMessage: string;
  // Aggregate progress tracking
  aggregateProgress: number;
  maxProgressReached: number;
  batchStartTime?: number;
  itemsCompleted: number;
  totalItems: number;
  smoothedProgress: number;
  // Real-time WebSocket data
  currentOperation?: string;
  currentOperationProgress?: number;
  realTimeProgress?: boolean;
  connectionStatus?: 'connected' | 'disconnected' | 'error';
  processingSpeed?: number;
  estimatedTimeRemaining?: number;
}

export default function ProcessingControls({
  video,
  timestampText,
  onProcessingComplete,
  generateCutdowns = false,
  generateGif = false,
  generateThumbnails = false,
  generateCanvas = false,
  aspectRatios = ['16:9'],
  onAspectRatiosChange,
  sessionId,
}: ProcessingControlsProps) {
  const [outputName, setOutputName] = useState("");
  const [quality, setQuality] = useState("balanced");
  const [videoFade, setVideoFade] = useState(false);
  const [audioFade, setAudioFade] = useState(false);
  const [fadeDuration, setFadeDuration] = useState("0.5");
  const [status, setStatus] = useState<ProcessingStatus>({
    isProcessing: false,
    progress: 0,
    currentClip: 0,
    totalClips: 0,
    totalGifs: 0,
    totalThumbnails: 0,
    totalCanvas: 0,
    processedClips: [],
    errors: [],
    canCancel: true,
    stage: 'preparing',
    simulatedProgress: 0,
    simulatedMessage: '',
    aggregateProgress: 0,
    maxProgressReached: 0,
    itemsCompleted: 0,
    totalItems: 0,
    smoothedProgress: 0,
  });
  const { toast } = useToast();
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const simulatedProgressRef = useRef<NodeJS.Timeout | null>(null);

  // Time estimation integration
  const { 
    estimate: timeEstimate, 
    calculateEstimate, 
    adjustEstimateFromProgress,
    getComplexityIndicators,
    loading: estimateLoading 
  } = useTimeEstimation({
    onEstimateUpdate: (estimate) => {
      console.log('🕒 Processing time estimate updated:', estimate.totalEstimatedDisplay);
    }
  });

  // WebSocket integration for real-time progress
  const { isConnected, progressData, connect, disconnect } = useWebSocketProgress({
    videoId: video?.id || null,
    onProgress: (data) => {
      // Calculate adjusted time estimate based on actual progress
      const adjustedEstimate = adjustEstimateFromProgress(
        data.progress, 
        (Date.now() - (status.startTime || Date.now())) / 1000
      );

      setStatus(prev => ({
        ...prev,
        progress: data.progress,
        currentOperation: data.currentOperation,
        currentOperationProgress: data.currentOperationProgress,
        estimatedTimeRemaining: adjustedEstimate?.adjustedDisplay ? 
          adjustedEstimate.adjustedEstimateSeconds : data.estimatedTimeRemaining,
        processingSpeed: data.processingSpeed,
        connectionStatus: 'connected',
        realTimeProgress: true,
        stage: data.progress < 30 ? 'preparing' : data.progress < 95 ? 'processing' : 'finalizing'
      }));
    },
    onComplete: (data) => {
      setStatus(prev => ({
        ...prev,
        progress: 100,
        isProcessing: false,
        stage: 'completed',
        downloadPath: data.downloadPath,
        connectionStatus: 'connected'
      }));
      
      if (data.downloadPath) {
        onProcessingComplete?.(data.downloadPath, data.r2DownloadUrl);
        toast({
          title: "Processing Complete!",
          description: "Your video exports are ready for download",
        });
      }
    },
    onError: (errors) => {
      setStatus(prev => ({
        ...prev,
        isProcessing: false,
        errors: errors,
        stage: 'preparing',
        connectionStatus: 'error'
      }));
      
      toast({
        title: "Processing Failed",
        description: errors[0] || "An error occurred during processing",
        variant: "destructive",
      });
    }
  });

  // Set default output name when video changes
  useEffect(() => {
    if (video && !outputName) {
      const name = video.originalName.replace(/\.[^/.]+$/, ""); // Remove extension
      setOutputName(name);
    }
  }, [video, outputName]);

  // Simulated progress system for initial stages
  const startSimulatedProgress = () => {
    if (simulatedProgressRef.current) {
      clearInterval(simulatedProgressRef.current);
    }

    const stages = [
      { message: "Scanning video metadata...", progress: 5, duration: 2000 },
      { message: "Preparing frame analysis...", progress: 12, duration: 3000 },
      { message: "Creating processing pipeline...", progress: 18, duration: 2500 },
      { message: "Initializing output generation...", progress: 25, duration: 3500 },
      { message: "Starting content generation...", progress: 30, duration: 2000 },
    ];

    let currentStage = 0;
    
    const updateSimulatedProgress = () => {
      if (currentStage < stages.length) {
        const stage = stages[currentStage];
        setStatus(prev => ({
          ...prev,
          simulatedProgress: stage.progress,
          simulatedMessage: stage.message,
          stage: 'preparing'
        }));
        
        currentStage++;
        simulatedProgressRef.current = setTimeout(updateSimulatedProgress, stage.duration);
      } else {
        // Transition to processing stage
        setStatus(prev => ({
          ...prev,
          stage: 'generating',
          simulatedMessage: 'Processing started...'
        }));
      }
    };

    updateSimulatedProgress();
  };

  const stopSimulatedProgress = () => {
    if (simulatedProgressRef.current) {
      clearInterval(simulatedProgressRef.current);
      simulatedProgressRef.current = null;
    }
  };

  // Aggregate progress calculation for unified batch tracking
  const calculateAggregateProgress = (progressData: any, prev: ProcessingStatus) => {
    const totalItems = (progressData.totalClips || 0) + (progressData.totalGifs || 0) + 
                      (progressData.totalThumbnails || 0) + (progressData.totalCanvas || 0);
    
    if (totalItems === 0) return { aggregateProgress: 0, itemsCompleted: 0, totalItems: 0 };

    // Calculate items completed based on current progress
    let itemsCompleted = 0;
    
    // Count completed clips (assuming each clip represents equal progress)
    if (progressData.totalClips > 0) {
      const clipProgress = Math.min(progressData.currentClip || 0, progressData.totalClips);
      itemsCompleted += clipProgress;
    }
    
    // For GIFs, thumbnails, and Canvas, estimate completion based on overall progress
    if (progressData.totalGifs > 0) {
      const gifProgress = (progressData.progress || 0) / 100 * progressData.totalGifs;
      itemsCompleted += Math.min(gifProgress, progressData.totalGifs);
    }
    
    if (progressData.totalThumbnails > 0) {
      const thumbProgress = (progressData.progress || 0) / 100 * progressData.totalThumbnails;
      itemsCompleted += Math.min(thumbProgress, progressData.totalThumbnails);
    }
    
    if (progressData.totalCanvas > 0) {
      const canvasProgress = (progressData.progress || 0) / 100 * progressData.totalCanvas;
      itemsCompleted += Math.min(canvasProgress, progressData.totalCanvas);
    }
    
    const aggregateProgress = Math.min((itemsCompleted / totalItems) * 100, 100);
    
    return { aggregateProgress, itemsCompleted: Math.floor(itemsCompleted), totalItems };
  };

  // Smooth progress function to prevent regression and large jumps
  const smoothProgress = (newProgress: number, currentProgress: number, maxReached: number) => {
    // Ensure progress never goes backward
    const forwardOnlyProgress = Math.max(newProgress, maxReached);
    
    // Smooth large jumps by limiting increment size
    const maxIncrement = 5; // Maximum 5% jump per update
    const smoothedProgress = Math.min(
      forwardOnlyProgress,
      currentProgress + maxIncrement
    );
    
    return {
      smoothedProgress: Math.min(smoothedProgress, 100),
      maxProgressReached: Math.max(forwardOnlyProgress, maxReached)
    };
  };

  // Estimate batch completion time
  const estimateBatchTime = (itemsCompleted: number, totalItems: number, startTime: number) => {
    if (itemsCompleted <= 0 || !startTime) return null;
    
    const elapsed = Date.now() - startTime;
    const averageTimePerItem = elapsed / itemsCompleted;
    const remainingItems = totalItems - itemsCompleted;
    
    return remainingItems * averageTimePerItem;
  };

  // Cleanup polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  const pollProgress = async (videoId: number) => {
    try {
      const response = await fetch(`/api/processing-progress/${videoId}`);
      if (response.ok) {
        const data = await response.json();
        console.log('Raw progress data from server:', data);
        return data;
      }
      console.log('Progress poll failed with status:', response.status);
      return null;
    } catch (error) {
      console.error('Progress polling error:', error);
      return null;
    }
  };

  const handleProcessClips = async () => {
    if (!video) {
      toast({
        title: "Cannot process",
        description: "Please upload a video first.",
        variant: "destructive",
      });
      return;
    }

    if (!generateCutdowns && !generateGif && !generateThumbnails && !generateCanvas) {
      toast({
        title: "Nothing to process",
        description: "Please enable at least one generation option.",
        variant: "destructive",
      });
      return;
    }

    if (generateCutdowns && !timestampText.trim()) {
      toast({
        title: "Timestamps required",
        description: "Please add timestamps for cutdown generation.",
        variant: "destructive",
      });
      return;
    }

    // Initialize WebSocket connection and processing state
    setStatus(prev => ({ 
      ...prev, 
      isProcessing: true,
      progress: 0,
      errors: [],
      connectionStatus: isConnected ? 'connected' : 'disconnected',
      realTimeProgress: true,
      stage: 'preparing',
      startTime: Date.now()
    }));

    try {
      // Use the new WebSocket-enabled processing endpoint
      const response = await apiRequest('POST', '/api/process-with-realtime', {
        videoId: video.id,
        timestampText: generateCutdowns ? timestampText : '',
        outputName,
        quality,
        aspectRatios,
        generateGif,
        generateThumbnails,
        generateCanvas,
        videoFade,
        audioFade,
        fadeDuration: parseFloat(fadeDuration),
        sessionId,
        // Professional service - no watermark parameters needed
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.message || 'Processing failed to start');
      }

      toast({
        title: "Processing Started",
        description: "Real-time progress tracking enabled. Watch the progress below.",
        duration: 3000,
      });

      // WebSocket will handle all progress updates from here
      
    } catch (error: any) {
      console.error('WebSocket processing error:', error);
      
      setStatus(prev => ({
        ...prev,
        isProcessing: false,
        errors: [error.message || 'Failed to start processing'],
        connectionStatus: 'error'
      }));

      toast({
        title: "Processing Failed",
        description: error.message || 'Failed to start processing',
        variant: "destructive",
      });
    }

    // Calculate total items for aggregate tracking
    const estimatedClips = generateCutdowns ? (timestampText.split('\n').filter(line => line.trim()).length * aspectRatios.length) : 0;
    const estimatedGifs = generateGif ? 10 : 0;
    const estimatedThumbnails = generateThumbnails ? 10 : 0;
    const estimatedCanvas = generateCanvas ? 5 : 0;
    const totalEstimatedItems = estimatedClips + estimatedGifs + estimatedThumbnails + estimatedCanvas;

    setStatus({
      isProcessing: true,
      progress: 0,
      currentClip: 0,
      totalClips: 0,
      processedClips: [],
      errors: [],
      canCancel: true,
      startTime: Date.now(),
      batchStartTime: Date.now(),
      stage: 'preparing',
      simulatedProgress: 0,
      simulatedMessage: 'Initializing processing...',
      aggregateProgress: 0,
      maxProgressReached: 0,
      itemsCompleted: 0,
      totalItems: totalEstimatedItems,
      smoothedProgress: 0,
    });

    // Start simulated progress
    startSimulatedProgress();

    try {
      // Start the processing job and poll for progress
      const processPromise = apiRequest('POST', '/api/process-with-realtime', {
        videoId: video.id,
        timestampText: generateCutdowns ? timestampText : '',
        generateCutdowns,
        quality,
        videoFade,
        audioFade,
        fadeDuration: parseFloat(fadeDuration),
        aspectRatios,
        generateGif,
        generateThumbnails,
        generateCanvas,
        sessionId
      });

      // Clear any existing polling interval
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }

      const initialResponse = await processPromise;
      if (!initialResponse.ok) {
        throw new Error(`HTTP error! status: ${initialResponse.status}`);
      }
      const result = await initialResponse.json();

      if (!result.success) {
        throw new Error(result.message || 'Processing failed');
      }

      // NEW BATCH PROCESSING: Server returns immediately with "processing started" response
      console.log('✅ Batch processing started:', result);
      
      // Update status with actual totals from server
      setStatus(prev => ({
        ...prev,
        totalClips: result.totalClips || 0,
        totalGifs: result.totalGifs || 0,
        totalThumbnails: result.totalThumbnails || 0,
        totalCanvas: result.totalCanvas || 0,
        totalItems: result.totalOutputs || totalEstimatedItems,
        stage: 'processing',
        simulatedMessage: 'Processing batch: starting generation...'
      }));

      // If processing finished immediately (edge case), handle completion
      if (result.downloadPath) {
        setStatus(prev => ({
          ...prev,
          isProcessing: false,
          progress: 100,
          aggregateProgress: 100,
          canCancel: false,
          downloadPath: result.downloadPath,
          stage: 'completed',
          simulatedProgress: 100
        }));
        
        toast({
          title: "Processing Complete!",
          description: `Successfully generated ${result.clipsProcessed || 'your content'}!`,
          duration: 4000,
        });
        return;
      }

      // Stop simulated progress once server confirms processing started
      stopSimulatedProgress();

      // Start polling for progress updates
      pollIntervalRef.current = setInterval(async () => {
        const progressData = await pollProgress(video.id);
        if (progressData) {
          console.log('Progress update received:', progressData);
          setStatus(prev => {
            // Calculate estimated time left with smoothing
            let estimatedTimeLeft;
            if (prev.startTime && progressData.progress > 5) {
              const elapsed = Date.now() - prev.startTime;
              const progressRatio = progressData.progress / 100;
              const totalEstimatedTime = elapsed / progressRatio;
              const rawTimeLeft = Math.max(0, totalEstimatedTime - elapsed);
              
              // Smooth the time estimation to prevent jumping
              estimatedTimeLeft = prev.estimatedTimeLeft ? 
                (prev.estimatedTimeLeft * 0.8 + rawTimeLeft * 0.2) : 
                rawTimeLeft;
            } else {
              estimatedTimeLeft = prev.estimatedTimeLeft;
            }

            // Stop simulated progress once real progress starts
            if (progressData.progress > 0 && prev.stage === 'preparing') {
              stopSimulatedProgress();
            }

            // Calculate aggregate progress using new system
            const { aggregateProgress, itemsCompleted, totalItems } = calculateAggregateProgress(progressData, prev);
            
            // Apply smooth progress to prevent regression and large jumps
            const { smoothedProgress, maxProgressReached } = smoothProgress(
              aggregateProgress, 
              prev.smoothedProgress, 
              prev.maxProgressReached
            );

            // Detect near-completion for finalizing stage
            const shouldShowFinalizing = smoothedProgress >= 95 && progressData.status !== 'completed';

            // Calculate batch-level time estimate
            const batchTimeLeft = prev.batchStartTime ? 
              estimateBatchTime(itemsCompleted, totalItems, prev.batchStartTime) : null;

            const newStatus = {
              ...prev,
              progress: progressData.progress || 0,
              currentClip: progressData.currentClip || 0,
              totalClips: progressData.totalClips || 0,
              totalGifs: progressData.totalGifs || 0,
              totalThumbnails: progressData.totalThumbnails || 0,
              totalCanvas: progressData.totalCanvas || 0,
              totalOutputs: progressData.totalOutputs || 0,
              errors: progressData.errors || [],
              stage: shouldShowFinalizing ? 'finalizing' : progressData.progress > 0 ? 'generating' : prev.stage,
              // Aggregate progress tracking
              aggregateProgress,
              maxProgressReached,
              itemsCompleted,
              totalItems: totalItems || prev.totalItems,
              smoothedProgress,
              estimatedTimeLeft: batchTimeLeft || estimatedTimeLeft,
            };
            console.log('New status:', newStatus);
            return newStatus;
          });

          // Check if processing is complete
          if (progressData.status === 'completed') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            stopSimulatedProgress();
            
            setStatus(prev => ({
              ...prev,
              isProcessing: false,
              progress: 100,
              totalClips: progressData.totalClips || 0,
              totalGifs: progressData.totalGifs || 0,
              totalThumbnails: progressData.totalThumbnails || 0,
              totalCanvas: progressData.totalCanvas || 0,
              totalOutputs: progressData.totalOutputs || 0,
              downloadPath: progressData.downloadPath,
              stage: 'finalizing',
              smoothedProgress: 100,
              maxProgressReached: 100,
              aggregateProgress: 100,
            }));

            const outputs = [];
            if (progressData.totalClips > 0) outputs.push(`${progressData.totalClips} clips`);
            if (progressData.totalGifs > 0) outputs.push(`${progressData.totalGifs} GIFs`);
            if (progressData.totalThumbnails > 0) outputs.push(`${progressData.totalThumbnails} thumbnails`);
            if (progressData.totalCanvas > 0) outputs.push(`${progressData.totalCanvas} Canvas loops`);
            
            toast({
              title: "Processing Complete!",
              description: `Successfully processed ${outputs.join(', ')}`,
            });

            onProcessingComplete(progressData.downloadPath, progressData.r2DownloadUrl);
          } else if (progressData.status === 'error') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setStatus(prev => ({
              ...prev,
              isProcessing: false,
              errors: progressData.errors || ['Processing failed'],
            }));

            toast({
              title: "Processing Failed",
              description: progressData.errors?.[0] || "Failed to process clips",
              variant: "destructive",
            });
          }
        }
      }, 1000); // Poll every second

      // Wait for the processing request to complete as backup
      try {
        await processPromise;
      } catch (processError) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        throw processError;
      }

    } catch (error: any) {
      console.error('Processing error:', error);
      
      // Check if this is a payment-related error
      if (error.status === 402 || (error.response && error.response.status === 402)) {
        setStatus(prev => ({
          ...prev,
          isProcessing: false,
          errors: ["Payment required to continue processing"],
        }));

        toast({
          title: "Payment Required",
          description: "Please complete payment before processing your video.",
          variant: "destructive",
        });
        
        // Redirect to pricing page or show payment form
        window.location.reload();
        return;
      }
      
      setStatus(prev => ({
        ...prev,
        isProcessing: false,
        errors: [error.message || "Failed to process clips"],
      }));

      toast({
        title: "Processing failed",
        description: error.message || "Failed to process video clips. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleCancel = async () => {
    if (!video) return;
    
    try {
      await apiRequest('POST', `/api/cancel-processing/${video.id}`);
      setStatus(prev => ({
        ...prev,
        isProcessing: false,
        canCancel: false,
      }));
      
      // Clear polling and simulated progress
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      stopSimulatedProgress();
      
      toast({
        title: "Processing Canceled",
        description: "Video processing has been stopped.",
      });
    } catch (error) {
      toast({
        title: "Failed to cancel",
        description: "Could not cancel processing. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleDownload = () => {
    if (status.downloadPath) {
      // For R2 downloads, open in new tab to handle redirects
      // For local downloads, use current window
      if (status.downloadPath.includes('download-r2')) {
        window.open(status.downloadPath, '_blank');
      } else {
        window.location.href = status.downloadPath;
      }
    }
  };

  const formatTimeLeft = (ms: number): string => {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    if (minutes > 0) {
      return `About ${minutes} min ${seconds} sec left`;
    } else {
      return `About ${seconds} sec left`;
    }
  };

  const canProcess = video && (generateCutdowns || generateGif || generateThumbnails || generateCanvas) && !status.isProcessing;

  // Lock all inputs during processing to prevent user disruption
  const isProcessingLocked = status.isProcessing;

  return (
    <div className="space-y-4">
      {/* Output Settings */}
      {!status.isProcessing && !status.downloadPath && (
        <div className={`space-y-4 bg-gray-50 p-4 rounded-lg ${isProcessingLocked ? 'opacity-50 pointer-events-none' : ''}`}>
          <h3 className="font-medium text-gray-800 mb-3">
            Output Settings
            {isProcessingLocked && (
              <span className="ml-2 text-xs text-amber-600 bg-amber-100 px-2 py-1 rounded">
                Locked during processing
              </span>
            )}
          </h3>
          
          {/* Quality Selection */}
          <div className="space-y-2">
            <Label htmlFor="quality">Quality</Label>
            <Select value={quality} onValueChange={setQuality} disabled={isProcessingLocked}>
              <SelectTrigger className={isProcessingLocked ? 'cursor-not-allowed' : ''}>
                <SelectValue placeholder="Select quality" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">High Quality (larger files)</SelectItem>
                <SelectItem value="balanced">Balanced (recommended)</SelectItem>
                <SelectItem value="compressed">Compressed (smaller files)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Music Video Features - Fade Effects (always visible) */}
          <div className="space-y-4 border-t pt-4">
            <h4 className="font-medium text-gray-700 flex items-center gap-2">
              <span className="bg-gradient-to-r from-purple-500 to-pink-500 text-white px-2 py-1 rounded-md text-xs">MUSIC VIDEO</span>
              Fade Effects
            </h4>

            {/* Video Fade Toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-blue-600" />
                <div>
                  <Label className="text-sm font-medium">Video Fade In/Out</Label>
                  <p className="text-xs text-gray-500">Smooth visual transitions</p>
                </div>
              </div>
              <Switch
                checked={videoFade}
                onCheckedChange={setVideoFade}
                disabled={isProcessingLocked || !generateCutdowns}
              />
            </div>

            {/* Audio Fade Toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-green-600" />
                <div>
                  <Label className="text-sm font-medium">Audio Fade In/Out</Label>
                  <p className="text-xs text-gray-500">Exponential audio curve</p>
                </div>
              </div>
              <Switch
                checked={audioFade}
                onCheckedChange={setAudioFade}
                disabled={isProcessingLocked || !generateCutdowns}
              />
            </div>

            {/* Fade Duration */}
            {(videoFade || audioFade) && (
              <div className="space-y-2 pl-6 border-l-2 border-purple-200">
                <Label className="text-sm">Fade Duration</Label>
                <Select
                  value={fadeDuration}
                  onValueChange={(value) => setFadeDuration(value)}
                  disabled={isProcessingLocked}
                >
                  <SelectTrigger className={`w-full ${isProcessingLocked ? 'cursor-not-allowed' : ''}`}>
                    <SelectValue placeholder="Select fade duration" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0.3">0.3 seconds (Quick)</SelectItem>
                    <SelectItem value="0.5">0.5 seconds (Standard)</SelectItem>
                    <SelectItem value="0.8">0.8 seconds (Smooth)</SelectItem>
                    <SelectItem value="1.0">1.0 seconds (Cinematic)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {!generateCutdowns && (
              <p className="text-xs text-gray-500 italic">
                Fade effects are only applied to Cut-Down exports. Enable Cut-Downs above to use this feature.
              </p>
            )}
          </div>

          {/* Show current Stage 2 settings (read-only) */}
          {(generateGif || generateThumbnails) && (
            <div className="space-y-4 border-t pt-4">
              <h4 className="font-medium text-gray-700 flex items-center gap-2">
                <span className="bg-gradient-to-r from-green-500 to-blue-500 text-white px-2 py-1 rounded-md text-xs">STAGE 2</span>
                Selected Exports
              </h4>
              
              {generateGif && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <FileImage className="w-4 h-4 text-orange-600" />
                  <span>10 GIFs (6-second clips, 640x480)</span>
                </div>
              )}
              
              {generateThumbnails && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Image className="w-4 h-4 text-purple-600" />
                  <span>10 Thumbnails (high-quality stills)</span>
                </div>
              )}
              
              {generateCanvas && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <div className="w-4 h-4 bg-gradient-to-r from-purple-500 to-green-500 rounded flex items-center justify-center">
                    <span className="text-white text-xs font-bold">S3</span>
                  </div>
                  <span>5 Spotify Canvas Loops (1080x1920, 8s)</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Time Estimation Display */}
      {video && (generateCutdowns || generateGif || generateThumbnails || generateCanvas) && !status.isProcessing && !status.downloadPath && (
        <TimeEstimationDisplay
          processingOptions={{
            timestampText,
            generateCutdowns,
            generateGif,
            generateThumbnails,
            generateCanvas,
            aspectRatios,
            quality,
            videoFade,
            audioFade
          }}
          videoData={{
            size: video.size,
            duration: video.duration || undefined,
            originalName: video.originalName
          }}
          onEstimateUpdate={(estimate) => {
            // Store estimate for use during processing
            console.log('🕒 Time estimate updated:', estimate.totalEstimatedDisplay);
          }}
        />
      )}

      {/* Aspect Ratio Export Options */}
      {generateCutdowns && (
        <div className="space-y-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 bg-gradient-to-r from-blue-500 to-purple-500 rounded flex items-center justify-center">
              <span className="text-xs font-bold text-white">AR</span>
            </div>
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
              Aspect Ratio Export Options
            </h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Choose your export format(s) - select multiple for dual format exports
          </p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className={`flex items-center justify-between p-3 bg-white dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 ${
              video?.aspectRatio === '16:9' ? 'ring-2 ring-blue-200 bg-blue-50 dark:bg-blue-900/20' : ''
            }`}>
              <div className="flex items-center space-x-3">
                <div className="w-8 h-5 bg-blue-100 dark:bg-blue-900 border border-blue-300 dark:border-blue-600 rounded flex items-center justify-center">
                  <span className="text-xs font-medium text-blue-600 dark:text-blue-300">16:9</span>
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">Widescreen</Label>
                    {video?.aspectRatio === '16:9' && (
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">Suggested</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">YouTube, desktop platforms</p>
                </div>
              </div>
              <Switch
                checked={aspectRatios.includes('16:9')}
                onCheckedChange={(checked) => {
                  if (onAspectRatiosChange) {
                    const newRatios = checked 
                      ? [...aspectRatios.filter(r => r !== '16:9'), '16:9']
                      : aspectRatios.filter(r => r !== '16:9');
                    onAspectRatiosChange(newRatios.length === 0 ? ['16:9'] : newRatios as ("16:9" | "9:16")[]);
                  }
                }}
              />
            </div>
            
            <div className={`flex items-center justify-between p-3 bg-white dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 ${
              video?.aspectRatio === '9:16' ? 'ring-2 ring-purple-200 bg-purple-50 dark:bg-purple-900/20' : ''
            }`}>
              <div className="flex items-center space-x-3">
                <div className="w-5 h-8 bg-purple-100 dark:bg-purple-900 border border-purple-300 dark:border-purple-600 rounded flex items-center justify-center">
                  <span className="text-xs font-medium text-purple-600 dark:text-purple-300 transform rotate-90">9:16</span>
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">Vertical + Motion Tracking</Label>
                    {video?.aspectRatio === '9:16' && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">Suggested</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">TikTok, Reels, Stories</p>
                </div>
              </div>
              <Switch
                checked={aspectRatios.includes('9:16')}
                onCheckedChange={(checked) => {
                  if (onAspectRatiosChange) {
                    const newRatios = checked 
                      ? [...aspectRatios.filter(r => r !== '9:16'), '9:16']
                      : aspectRatios.filter(r => r !== '9:16');
                    onAspectRatiosChange(newRatios.length === 0 ? ['16:9'] : newRatios as ("16:9" | "9:16")[]);
                  }
                }}
              />
            </div>
          </div>
          
          {aspectRatios.length > 1 && (
            <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
              <p className="text-sm text-blue-700 dark:text-blue-300 font-medium">
                Dual Export: Both {aspectRatios.join(' and ')} versions will be generated
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                Organized in separate folders: "clips (16x9)" and "clips (9x16)"
              </p>
            </div>
          )}
        </div>
      )}

      {/* Process Button */}
      {!status.isProcessing && !status.downloadPath && (
        <Button
          onClick={handleProcessClips}
          disabled={!canProcess}
          className="w-full bg-brand-green text-white hover:bg-brand-green-dark py-4 text-lg font-semibold"
        >
          <Scissors className="w-5 h-5 mr-2" />
          {(() => {
            const selectedTypes = [];
            if (generateCutdowns) selectedTypes.push('Cutdowns');
            if (generateGif) selectedTypes.push('GIFs');
            if (generateThumbnails) selectedTypes.push('Thumbnails');
            if (generateCanvas) selectedTypes.push('Spotify Canvas');
            
            if (selectedTypes.length === 0) {
              return 'Select content to generate';
            }
            
            const fadeText = (generateCutdowns && (videoFade || audioFade)) ? ' with Fades' : '';
            return `Generate ${selectedTypes.join(' & ')}${fadeText}`;
          })()}
        </Button>
      )}

      {/* Real-Time Processing Progress */}
      {status.isProcessing && (
        <div className="bg-gradient-to-br from-blue-50 via-white to-green-50 border border-blue-200 rounded-xl p-6 space-y-6 shadow-lg">
          {/* Don't Reload Warning */}
          <Alert className="bg-amber-50 border-amber-200">
            <AlertDescription className="text-amber-800 text-center font-medium">
              ⚠️ Don't reload the page while processing! Your files are being created...
            </AlertDescription>
          </Alert>
          
          {/* Main Progress Header */}
          <div className="text-center space-y-3">
            <div className="flex items-center justify-center space-x-3">
              <div className={`w-3 h-3 rounded-full animate-pulse ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <h3 className="text-xl font-bold text-gray-800">
                {progressData?.currentOperation || status.currentOperation || 'Processing Video'}
              </h3>
              <div className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
                {isConnected ? 'Live Tracking' : 'Reconnecting...'}
              </div>
            </div>
            
            {/* Primary Progress Bar with Real-Time Data */}
            <div className="max-w-2xl mx-auto space-y-3">
              <div className="relative">
                <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden shadow-inner">
                  <div 
                    className="bg-gradient-to-r from-blue-500 via-blue-600 to-green-500 h-full rounded-full transition-all duration-500 ease-out relative"
                    style={{ 
                      width: `${Math.max(progressData?.progress || status.progress || 0, 0)}%`,
                      boxShadow: (progressData?.progress ?? 0) > 0 ? '0 0 15px rgba(59, 130, 246, 0.6)' : 'none'
                    }}
                  >
                    <div className="absolute inset-0 bg-white opacity-20 animate-pulse"></div>
                  </div>
                </div>
                
                {/* Progress Percentage Overlay */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-sm font-bold text-gray-800 bg-white bg-opacity-90 px-2 py-1 rounded shadow">
                    {Math.round(progressData?.progress || status.progress || 0)}%
                  </span>
                </div>
              </div>
              
              {/* Time and Speed Info */}
              <div className="flex justify-between items-center text-sm">
                <div className="flex items-center space-x-4">
                  {progressData?.estimatedTimeRemaining && progressData.estimatedTimeRemaining > 0 && (
                    <span className="text-blue-600 font-medium">
                      {Math.round(progressData.estimatedTimeRemaining)}s remaining
                    </span>
                  )}
                  {progressData?.processingSpeed && (
                    <span className="text-green-600 font-medium">
                      {progressData.processingSpeed}x speed
                    </span>
                  )}
                  {timeEstimate && (
                    <span className="text-purple-600 font-medium">
                      {timeEstimate.bulkProcessingDetected && '📊 Bulk • '}
                      Est: {timeEstimate.totalEstimatedDisplay}
                    </span>
                  )}
                </div>
                <div className="text-gray-600">
                  {(progressData?.totalItems ?? 0) > 0 && (
                    <span>Item {progressData?.currentItem || 1} of {progressData?.totalItems}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

              
              {/* FFmpeg Real-Time Data Dashboard */}
          {progressData?.ffmpegProgress && (
            <div className="bg-white bg-opacity-80 backdrop-blur-sm rounded-xl p-4 border border-gray-200 shadow-md">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-bold text-gray-700">FFmpeg Real-Time Output</h4>
                <div className="flex items-center space-x-1 text-xs">
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                  <span className="text-green-600 font-medium">Live Data</span>
                </div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-blue-50 rounded-lg px-3 py-2 text-center border border-blue-200">
                  <div className="text-xs font-medium text-blue-600 mb-1">Frame</div>
                  <div className="text-sm font-bold text-blue-800">
                    {progressData.ffmpegProgress.frame.toLocaleString()}
                  </div>
                </div>
                
                <div className="bg-green-50 rounded-lg px-3 py-2 text-center border border-green-200">
                  <div className="text-xs font-medium text-green-600 mb-1">Speed</div>
                  <div className="text-sm font-bold text-green-800">
                    {progressData.ffmpegProgress.speed}
                  </div>
                </div>
                
                <div className="bg-purple-50 rounded-lg px-3 py-2 text-center border border-purple-200">
                  <div className="text-xs font-medium text-purple-600 mb-1">Time</div>
                  <div className="text-sm font-bold text-purple-800">
                    {progressData.ffmpegProgress.time}
                  </div>
                </div>
                
                <div className="bg-orange-50 rounded-lg px-3 py-2 text-center border border-orange-200">
                  <div className="text-xs font-medium text-orange-600 mb-1">FPS</div>
                  <div className="text-sm font-bold text-orange-800">
                    {progressData.ffmpegProgress.fps}
                  </div>
                </div>
              </div>
              
              {progressData.ffmpegProgress.bitrate && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="bg-gray-50 rounded-lg px-3 py-2 text-center border border-gray-200">
                    <div className="text-xs font-medium text-gray-600 mb-1">Bitrate</div>
                    <div className="text-sm font-bold text-gray-800">
                      {progressData.ffmpegProgress.bitrate}
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg px-3 py-2 text-center border border-gray-200">
                    <div className="text-xs font-medium text-gray-600 mb-1">Size</div>
                    <div className="text-sm font-bold text-gray-800">
                      {progressData.ffmpegProgress.size}
                    </div>
                  </div>
                </div>
              )}
              
              <div className="mt-3 text-center">
                <div className="text-xs text-gray-500 bg-gray-100 px-3 py-1 rounded-full inline-block">
                  FFmpeg -progress pipe:1 | 100% Accurate Tracking
                </div>
              </div>
            </div>
          )}

          {/* Cloudflare Queue Worker Status */}
          {progressData?.usingQueue && progressData.workerProgress && (
            <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-2">
                  <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></div>
                  <span className="font-bold text-blue-700">Cloudflare Worker</span>
                </div>
                <span className="text-xs bg-blue-200 text-blue-700 px-2 py-1 rounded-full">
                  Queue Job: {progressData.queueJobId?.slice(-8)}
                </span>
              </div>
              <div className="text-center">
                <div className="text-sm font-medium text-blue-600 capitalize mb-1">
                  {progressData.workerProgress.stage}
                </div>
                {progressData.workerProgress.detail && (
                  <div className="text-xs text-blue-500">
                    {progressData.workerProgress.detail}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Connection Status and Analytics */}
          <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-xs text-gray-500 mb-1">Connection</div>
                <div className={`text-sm font-bold ${isConnected ? 'text-green-600' : 'text-red-600'}`}>
                  {isConnected ? 'Live WebSocket' : 'Reconnecting...'}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Accuracy</div>
                <div className="text-sm font-bold text-blue-600">
                  {progressData?.realTimeAccuracy ? '100% Accurate' : 'Estimated'}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Storage</div>
                <div className="text-sm font-bold text-purple-600">
                  Cloudflare R2
                </div>
              </div>
            </div>
          </div>
              
          {status.canCancel && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              className="mt-4"
            >
              Cancel Processing
            </Button>
          )}
        </div>
      )}

      {/* Processing Errors */}
      {status.errors.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-red-600">Issues During Processing:</h4>
          {status.errors.map((error, index) => (
            <Alert key={index} variant="destructive" className="text-left">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      {/* Success & Download Section */}
      {status.downloadPath && !status.isProcessing && (
        <div className="text-center py-8">
          <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-4">
            <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-green-800 mb-2">
              {(() => {
                if (status.totalClips > 0) return 'All clips ready!';
                const activeTypes = [
                  (status.totalGifs || 0) > 0 && 'GIFs',
                  (status.totalThumbnails || 0) > 0 && 'thumbnails',
                  (status.totalCanvas || 0) > 0 && 'Canvas loops'
                ].filter(Boolean);
                if (activeTypes.length > 1) return 'All exports ready!';
                if ((status.totalGifs || 0) > 0) return 'All GIFs ready!';
                if ((status.totalThumbnails || 0) > 0) return 'All thumbnails ready!';
                if ((status.totalCanvas || 0) > 0) return 'All Canvas loops ready!';
                return 'All content ready!';
              })()}
            </h3>
            <p className="text-green-700 mb-4">
              Successfully processed {(() => {
                const outputs = [];
                if (status.totalClips > 0) outputs.push(`${status.totalClips} clips`);
                if ((status.totalGifs || 0) > 0) outputs.push(`${status.totalGifs || 0} GIFs`);
                if ((status.totalThumbnails || 0) > 0) outputs.push(`${status.totalThumbnails || 0} thumbnails`);
                if ((status.totalCanvas || 0) > 0) outputs.push(`${status.totalCanvas || 0} Canvas loops`);
                return outputs.length > 0 ? outputs.join(', ') : 'content';
              })()} and packaged them for download.
            </p>
            
            {/* Watermark Confirmation Message */}
            <div className="mb-6 p-4 bg-green-100 border border-green-300 rounded-lg">
              <div className="flex items-center justify-center gap-2 text-green-800">
                <CheckCircle className="w-5 h-5" />
                <p className="text-sm font-medium">
                  ✅ Your professional quality export is being generated. Perfect for pitching, sharing, or publishing.
                </p>
              </div>
            </div>
            <Progress value={100} className="h-2 mb-4 bg-green-100" />
            <Button
              onClick={handleDownload}
              size="lg"
              className="bg-green-600 text-white hover:bg-green-700 px-8 py-4 text-lg font-semibold"
            >
              <Download className="w-6 h-6 mr-3" />
              Download ZIP File
              {status.downloadPath?.includes('download-r2') && (
                <span className="ml-2 text-xs bg-white/20 px-2 py-1 rounded">Cloud</span>
              )}
            </Button>
          </div>

          {/* Post-Download Feedback Prompt */}
          <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="text-center space-y-3">
              <div className="flex items-center justify-center gap-2">
                <MessageCircle className="w-5 h-5 text-blue-600" />
                <h4 className="text-sm font-medium text-blue-800">
                  How was your experience?
                </h4>
              </div>
              <p className="text-xs text-blue-600 leading-relaxed">
                Help us improve CUTMV by sharing your feedback! Your insights help us build better tools for creators like you.
              </p>
              <Button
                onClick={async () => {
                  // Auto-fill feedback with session context
                  const sessionContext = {
                    totalClips: status.totalClips,
                    totalGifs: status.totalGifs,
                    totalThumbnails: status.totalThumbnails,
                    totalCanvas: status.totalCanvas
                  };

                  logUserEvent('post_download_feedback_clicked', sessionContext);
                  
                  // Trigger the floating feedback button
                  const feedbackButton = document.querySelector('[data-feedback-button]') as HTMLButtonElement;
                  if (feedbackButton) {
                    feedbackButton.click();
                  }
                }}
                variant="outline"
                size="sm"
                className="text-blue-700 border-blue-300 hover:bg-blue-100 px-4 py-2"
              >
                <MessageCircle className="w-4 h-4 mr-2" />
                Give Feedback
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
