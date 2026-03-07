import { useCallback, useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, Video, Trash2, Play, Shield, AlertCircle, FileVideo, CheckCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Video as VideoType } from "@shared/schema";

interface VideoUploadProps {
  onVideoUpload: (video: VideoType) => void;
  uploadedVideo: VideoType | null;
}

// Security configuration
const SECURITY_CONFIG = {
  MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024, // 10GB
  ALLOWED_EXTENSIONS: ['.mp4', '.mov', '.mkv'],
  ALLOWED_MIME_TYPES: [
    'video/mp4',
    'video/quicktime', 
    'video/x-matroska',
    'video/x-msvideo',
    'video/avi',
    'video/3gpp',
    'video/3gpp2',
    'application/octet-stream' // Mobile browsers sometimes report this
  ]
};

export default function VideoUpload({ onVideoUpload, uploadedVideo }: VideoUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessingVideo, setIsProcessingVideo] = useState(false);
  const [uploadController, setUploadController] = useState<AbortController | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [artistInfo, setArtistInfo] = useState("");
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  const [authStatus, setAuthStatus] = useState<'checking' | 'valid' | 'invalid'>('checking');
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const { toast } = useToast();

  // Update video metadata in database when user edits fields after upload
  const updateVideoMetadata = async (videoId: number, title: string, artist: string) => {
    try {
      await fetch(`/api/videos/${videoId}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          videoTitle: title.trim() || null,
          artistInfo: artist.trim() || null
        })
      });
      console.log('✅ Video metadata updated:', { videoTitle: title, artistInfo: artist });
    } catch (error) {
      console.error('Failed to update video metadata:', error);
    }
  };

  // Automatic background authentication validation
  useEffect(() => {
    const validateAuth = async () => {
      try {
        console.log('🔐 Background auth validation:', {
          cookies: document.cookie,
          hasSession: document.cookie.includes('cutmv-session'),
          timestamp: new Date().toISOString()
        });

        const response = await fetch('/api/auth/me', {
          method: 'GET',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
          const data = await response.json();
          console.log('✅ Authentication valid for user:', data.user?.email);
          setAuthStatus('valid');
        } else {
          console.log('❌ Authentication invalid:', await response.text());
          setAuthStatus('invalid');
        }
      } catch (error) {
        console.error('❌ Auth validation failed:', error);
        setAuthStatus('invalid');
      }
    };

    validateAuth();
    
    // Re-validate auth every 5 minutes to catch session expiration
    const interval = setInterval(validateAuth, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Create local preview URL from selected file
  useEffect(() => {
    // Create new preview URL from selected file
    if (selectedFile) {
      const previewUrl = URL.createObjectURL(selectedFile);
      setVideoPreviewUrl(previewUrl);
      console.log('✅ Created local video preview from file:', previewUrl);

      // Cleanup function to revoke object URL when component unmounts or file changes
      return () => {
        console.log('🧹 Revoking blob URL:', previewUrl);
        URL.revokeObjectURL(previewUrl);
      };
    } else {
      setVideoPreviewUrl(null);
    }
  }, [selectedFile]);

  // Cancel upload function
  const cancelUpload = () => {
    if (uploadController) {
      uploadController.abort();
      setUploadController(null);
    }

    // Reset all upload state
    setIsUploading(false);
    setUploadProgress(0);
    setIsProcessingVideo(false);
    setSelectedFile(null);

    // Reset file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    if (fileInput) {
      fileInput.value = '';
    }

    toast({
      title: "Upload cancelled",
      description: "Video upload has been cancelled.",
    });
  };

  // AI metadata suggestion function - now returns the suggested values
  const generateAISuggestions = async (file: File): Promise<{ videoTitle: string; artistInfo: string } | null> => {
    if (!file) return null;

    setIsGeneratingSuggestions(true);

    try {
      // Debug authentication before making the request
      console.log('🔐 Auth debug for metadata request:', {
        cookies: document.cookie,
        hasSession: document.cookie.includes('cutmv-session'),
        timestamp: new Date().toISOString()
      });

      const response = await fetch('/api/suggest-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include', // Include authentication cookies
        body: JSON.stringify({
          originalName: file.name,
          size: file.size,
          format: file.type
        }),
      });

      const data = await response.json();

      console.log('🤖 AI suggestion response:', {
        success: data.success,
        source: data.source,
        suggestion: data.suggestion,
        currentVideoTitle: videoTitle,
        currentArtistInfo: artistInfo,
        videoTitleEmpty: !videoTitle.trim(),
        artistInfoEmpty: !artistInfo.trim()
      });

      let suggestedVideoTitle = videoTitle;
      let suggestedArtistInfo = artistInfo;

      if (data.success && data.suggestion) {
        // Only apply AI suggestions if the fields are currently empty
        // This prevents overwriting user input
        if (!videoTitle.trim() && data.suggestion.videoTitle) {
          console.log('✅ Applying AI suggestion for video title:', data.suggestion.videoTitle);
          setVideoTitle(data.suggestion.videoTitle);
          suggestedVideoTitle = data.suggestion.videoTitle;
        } else if (videoTitle.trim()) {
          console.log('⏭️ Skipping video title suggestion - user already entered:', videoTitle);
        }

        if (!artistInfo.trim() && data.suggestion.artistInfo) {
          console.log('✅ Applying AI suggestion for artist info:', data.suggestion.artistInfo);
          setArtistInfo(data.suggestion.artistInfo);
          suggestedArtistInfo = data.suggestion.artistInfo;
        } else if (artistInfo.trim()) {
          console.log('⏭️ Skipping artist info suggestion - user already entered:', artistInfo);
        }

        // Only show toast for successful AI suggestions, not basic ones
        if (data.source === 'ai' && (!videoTitle.trim() || !artistInfo.trim())) {
          toast({
            title: "AI suggestions generated",
            description: `Generated suggestions with ${Math.round(data.suggestion.confidence * 100)}% confidence`,
          });
        }
      } else if (data.message !== 'No suggestions generated') {
        throw new Error(data.message || 'Failed to generate suggestions');
      }

      return { videoTitle: suggestedVideoTitle, artistInfo: suggestedArtistInfo };
    } catch (error) {
      console.warn('AI suggestion error (non-critical):', error);
      // Silent fail for AI suggestions - they're not critical for upload functionality
      // Don't show error toast to user, just log for debugging
      return null;
    } finally {
      setIsGeneratingSuggestions(false);
    }
  };

  // Upload state persistence for resume capability
  interface UploadState {
    uploadId: string;
    r2Key: string;
    fileName: string;
    fileSize: number;
    chunkSize: number;
    totalChunks: number;
    completedParts: Array<{ PartNumber: number; ETag: string }>;
    startedAt: number;
    lastUpdated: number;
  }

  const UPLOAD_STATE_PREFIX = 'cutmv_upload_';
  const UPLOAD_STATE_EXPIRY = 12 * 60 * 60 * 1000; // 12 hours (matches presigned URL expiry)

  // Save upload state to localStorage
  const saveUploadState = (state: UploadState) => {
    try {
      const key = `${UPLOAD_STATE_PREFIX}${state.fileName}`;
      localStorage.setItem(key, JSON.stringify({
        ...state,
        lastUpdated: Date.now()
      }));
    } catch (error) {
      console.warn('Failed to save upload state:', error);
    }
  };

  // Load upload state from localStorage
  const loadUploadState = (fileName: string): UploadState | null => {
    try {
      const key = `${UPLOAD_STATE_PREFIX}${fileName}`;
      const stored = localStorage.getItem(key);
      if (!stored) return null;

      const state: UploadState = JSON.parse(stored);

      // Check if state is expired (older than 12 hours)
      if (Date.now() - state.lastUpdated > UPLOAD_STATE_EXPIRY) {
        console.log('Upload state expired, removing...');
        localStorage.removeItem(key);
        return null;
      }

      return state;
    } catch (error) {
      console.warn('Failed to load upload state:', error);
      return null;
    }
  };

  // Clear upload state from localStorage
  const clearUploadState = (fileName: string) => {
    try {
      const key = `${UPLOAD_STATE_PREFIX}${fileName}`;
      localStorage.removeItem(key);
    } catch (error) {
      console.warn('Failed to clear upload state:', error);
    }
  };

  // Helper function for direct-to-R2 chunk upload with retry logic
  const uploadChunkToR2 = async (
    presignedUrl: string,
    chunk: Blob,
    partNumber: number,
    totalChunks: number,
    abortController: AbortController,
    completedChunks: Set<number>,
    failedChunks: Map<number, number>,
    maxRetries: number
  ): Promise<string> => {
    const retryCount = failedChunks.get(partNumber) || 0;

    try {
      const timeoutMs = 300000; // 5 minutes per chunk for large files/slow connections

      const response = await Promise.race([
        fetch(presignedUrl, {
          method: 'PUT',
          body: chunk,
          signal: abortController.signal,
          headers: {
            'Content-Type': 'application/octet-stream'
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Part ${partNumber} timeout after ${timeoutMs/1000}s`)), timeoutMs)
        )
      ]);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Extract ETag from response headers (required for multipart completion)
      const etag = response.headers.get('ETag');
      if (!etag) {
        throw new Error(`No ETag returned for part ${partNumber}`);
      }

      // Success - mark chunk as completed
      completedChunks.add(partNumber);
      const progress = Math.round((completedChunks.size / totalChunks) * 100);
      setUploadProgress(progress);

      if (retryCount > 0) {
        console.log(`✅ Part ${partNumber}/${totalChunks} uploaded to R2 after ${retryCount} retries (${progress}%)`);
      } else {
        console.log(`✅ Part ${partNumber}/${totalChunks} uploaded to R2 (${progress}%)`);
      }

      return etag;

    } catch (error) {
      const newRetryCount = retryCount + 1;

      if (newRetryCount <= maxRetries && !abortController.signal.aborted) {
        console.warn(`⚠️ Part ${partNumber} failed (attempt ${newRetryCount}/${maxRetries}), retrying...`, error);
        failedChunks.set(partNumber, newRetryCount);

        // Exponential backoff delay with jitter for network errors
        const baseDelay = 1000 * Math.pow(2, newRetryCount - 1);
        const jitter = Math.random() * 1000; // Add randomness to prevent thundering herd
        // On final retry (5th attempt), give extra time for network recovery
        const maxDelay = newRetryCount >= maxRetries ? 15000 : 10000;
        const delay = Math.min(baseDelay + jitter, maxDelay);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry the chunk
        return uploadChunkToR2(presignedUrl, chunk, partNumber, totalChunks, abortController, completedChunks, failedChunks, maxRetries);
      } else {
        console.error(`❌ Part ${partNumber} failed permanently after ${retryCount} retries:`, error);
        throw error;
      }
    }
  };

  // NEW: Direct browser-to-R2 multipart upload (50-70% faster!)
  const uploadDirectToR2 = async (file: File, chunkSize: number, abortController: AbortController): Promise<Response> => {
    const totalChunks = Math.ceil(file.size / chunkSize);
    const completedChunks = new Set<number>();
    const failedChunks = new Map<number, number>();

    const fileSizeGB = file.size / (1024 * 1024 * 1024);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                     window.innerWidth <= 768;

    // More conservative batch sizing for better stability on poor connections
    let batchSize = isMobile
      ? (fileSizeGB > 5 ? 2 : 3)  // Reduced from 3:4
      : (fileSizeGB > 5 ? 4 : 5);  // Reduced from 5:6

    const maxRetries = 5; // Increased retries for better resilience to network errors
    let consecutiveFailures = 0; // Track failures to adapt batch size

    console.log(`🚀 Starting DIRECT-TO-R2 upload: ${file.name}`);
    console.log(`📊 Upload details: ${totalChunks} parts, ${Math.round(chunkSize/1024/1024)}MB each, ${(file.size/1024/1024).toFixed(2)}MB total`);
    console.log(`⚡ OPTIMIZED: ${batchSize} parallel direct uploads to R2 (${isMobile ? 'mobile' : 'desktop'})`);

    // Check for existing upload state to resume
    const existingState = loadUploadState(file.name);
    let uploadId: string;
    let r2Key: string;
    let presignedUrls: string[];
    const parts: Array<{ PartNumber: number; ETag: string }> = [];

    if (existingState && existingState.fileSize === file.size && existingState.chunkSize === chunkSize) {
      console.log(`🔄 RESUMING upload from ${existingState.completedParts.length}/${totalChunks} parts`);
      uploadId = existingState.uploadId;
      r2Key = existingState.r2Key;

      // Restore completed parts
      existingState.completedParts.forEach(part => {
        parts[part.PartNumber - 1] = part;
        completedChunks.add(part.PartNumber);
      });

      // Update progress immediately to show resume state
      setUploadProgress(Math.round((completedChunks.size / totalChunks) * 100));

      // Need to get fresh presigned URLs for remaining parts (old ones may be expired)
      console.log('📡 Requesting fresh presigned URLs for resume...');
      const resumeResponse = await fetch('/api/initiate-multipart-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          totalChunks: totalChunks,
          existingUploadId: uploadId, // Tell server to reuse existing upload
          existingR2Key: r2Key
        }),
        signal: abortController.signal
      });

      if (!resumeResponse.ok) {
        console.warn('Failed to get fresh URLs for resume, starting fresh upload...');
        clearUploadState(file.name);
        // Fall through to start new upload
      } else {
        const resumeData = await resumeResponse.json();
        presignedUrls = resumeData.presignedUrls;
        console.log(`✅ Resuming with ${presignedUrls.length} fresh presigned URLs`);

        toast({
          title: "Resuming upload",
          description: `Continuing from ${existingState.completedParts.length}/${totalChunks} parts`,
        });
      }
    }

    // If not resuming, start new upload
    if (!uploadId || !r2Key || !presignedUrls) {
      console.log('📡 Step 1/3: Requesting presigned URLs from server...');
      const initiateResponse = await fetch('/api/initiate-multipart-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          totalChunks: totalChunks
        }),
        signal: abortController.signal
      });

      if (!initiateResponse.ok) {
        const errorData = await initiateResponse.json();

        // Handle rate limiting specifically
        if (initiateResponse.status === 429) {
          toast({
            title: "Upload limit reached",
            description: errorData.message || "You have too many active uploads. Please wait for one to complete.",
            variant: "destructive",
            duration: 7000,
          });
          throw new Error(errorData.message || 'Upload limit exceeded');
        }

        if (initiateResponse.status === 503) {
          toast({
            title: "Service busy",
            description: errorData.message || "Too many concurrent uploads. Please try again in a moment.",
            variant: "destructive",
            duration: 7000,
          });
          throw new Error(errorData.message || 'Service temporarily unavailable');
        }

        throw new Error(errorData.message || `Failed to initiate upload: ${initiateResponse.status}`);
      }

      const initiateData = await initiateResponse.json();
      uploadId = initiateData.uploadId;
      r2Key = initiateData.r2Key;
      presignedUrls = initiateData.presignedUrls;

      // Initialize upload state for new upload
      saveUploadState({
        uploadId,
        r2Key,
        fileName: file.name,
        fileSize: file.size,
        chunkSize,
        totalChunks,
        completedParts: [],
        startedAt: Date.now(),
        lastUpdated: Date.now()
      });
    }
    console.log(`✅ Received ${presignedUrls.length} presigned URLs from server`);
    console.log(`🔑 R2 Upload ID: ${uploadId}`);

    // Step 2: Upload chunks directly to R2 using presigned URLs
    console.log('📡 Step 2/3: Uploading directly to R2...');

    try {
      for (let batchStart = 0; batchStart < totalChunks; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, totalChunks);
        const batchPromises = [];

        const failuresBeforeBatch = failedChunks.size;

        for (let i = batchStart; i < batchEnd; i++) {
          const partNumber = i + 1; // S3 part numbers are 1-indexed

          // Skip already completed parts (for resume)
          if (completedChunks.has(partNumber)) {
            console.log(`⏭️ Skipping part ${partNumber}/${totalChunks} (already uploaded)`);
            continue;
          }

          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          const chunk = file.slice(start, end);

          const uploadPromise = uploadChunkToR2(
            presignedUrls[i],
            chunk,
            partNumber,
            totalChunks,
            abortController,
            completedChunks,
            failedChunks,
            maxRetries
          ).then(etag => {
            parts[i] = { PartNumber: partNumber, ETag: etag };
          });

          batchPromises.push(uploadPromise);
        }

        // Wait for batch to complete
        if (batchPromises.length > 0) {
          await Promise.all(batchPromises);

          // Save upload state after each successful batch
          const completedParts = parts.filter(p => p).map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag }));
          saveUploadState({
            uploadId,
            r2Key,
            fileName: file.name,
            fileSize: file.size,
            chunkSize,
            totalChunks,
            completedParts,
            startedAt: existingState?.startedAt || Date.now(),
            lastUpdated: Date.now()
          });
        }

        // Adaptive batch sizing: reduce parallelism if network is unstable
        const retriesInBatch = failedChunks.size - failuresBeforeBatch;
        if (retriesInBatch > batchSize / 2 && batchSize > 2) {
          batchSize = Math.max(2, Math.floor(batchSize * 0.7)); // Reduce by 30%
          console.log(`⚠️ High retry rate detected, reducing batch size to ${batchSize} for better stability`);
        }
      }

      console.log(`✅ All ${totalChunks} parts uploaded directly to R2!`);

      // Step 3: Complete multipart upload
      console.log('📡 Step 3/3: Finalizing multipart upload...');
      setIsProcessingVideo(true);

      const completeResponse = await fetch('/api/complete-multipart-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          uploadId,
          r2Key,
          parts: parts.filter(p => p), // Remove any undefined entries
          fileName: file.name,
          videoTitle: videoTitle || null,
          artistInfo: artistInfo || null
        }),
        signal: abortController.signal
      });

      if (!completeResponse.ok) {
        let errorMessage = `Failed to complete upload: ${completeResponse.status}`;
        try {
          const contentType = completeResponse.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const errorData = await completeResponse.json();
            errorMessage = errorData.message || errorMessage;
          } else {
            // Server returned HTML or non-JSON (likely error page)
            const errorText = await completeResponse.text();
            console.error('Server returned non-JSON response:', errorText.substring(0, 200));
            errorMessage = 'Server error. Please refresh the page and try again.';
          }
        } catch (parseError) {
          console.error('Failed to parse error response:', parseError);
        }
        throw new Error(errorMessage);
      }

      console.log('✅ Direct-to-R2 upload completed successfully!');

      // Clear upload state on successful completion
      clearUploadState(file.name);
      console.log('🧹 Cleared upload state after successful completion');

      return completeResponse;

    } catch (error) {
      // Keep upload state for resume - only clear if user explicitly aborts
      console.log('❌ Upload failed - state preserved for resume');

      // Only abort and clear state if user explicitly cancelled (not network errors)
      if (abortController.signal.aborted) {
        console.log('🛑 User aborted upload, clearing state...');
        try {
          await fetch('/api/abort-multipart-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ uploadId, r2Key })
          });
          console.log('✅ Multipart upload aborted');
          clearUploadState(file.name);
        } catch (abortError) {
          console.error('Failed to abort multipart upload:', abortError);
        }
      } else {
        // Network error or other failure - preserve state for resume
        console.log('💾 Upload state preserved for resume. Try uploading the same file again to resume.');
        toast({
          title: "Upload paused",
          description: "Upload the same file again to resume from where you left off.",
          duration: 7000,
        });
      }
      throw error;
    }
  };

  // Security: Client-side file validation
  const validateFile = (file: File): { valid: boolean; error?: string } => {
    // Check file size
    if (file.size > SECURITY_CONFIG.MAX_FILE_SIZE) {
      return {
        valid: false,
        error: `File size exceeds 10GB limit. Your file is ${(file.size / (1024 * 1024 * 1024)).toFixed(2)}GB.`
      };
    }
    
    // Check file extension
    const extension = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!SECURITY_CONFIG.ALLOWED_EXTENSIONS.includes(extension)) {
      return {
        valid: false,
        error: `Invalid file type. Please upload: ${SECURITY_CONFIG.ALLOWED_EXTENSIONS.join(', ')}`
      };
    }
    
    // Check MIME type (lenient for mobile browsers)
    if (file.type && !SECURITY_CONFIG.ALLOWED_MIME_TYPES.includes(file.type)) {
      // Allow files with valid extensions but unknown MIME types (mobile browsers)
      console.warn(`Unknown MIME type ${file.type} for ${file.name}, allowing based on extension`);
    }
    
    return { valid: true };
  };

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    // Prevent new uploads during active upload
    if (isUploading) {
      console.log('Upload already in progress, ignoring new file selection');
      return;
    }
    const file = acceptedFiles[0];
    if (!file) return;

    console.log('Starting secure upload for file:', file.name, 'Size:', file.size, 'Type:', file.type);
    console.log('📋 Metadata will be set by user after upload completes');

    // Security: Validate file before upload
    const validation = validateFile(file);
    if (!validation.valid) {
      toast({
        title: "Invalid file",
        description: validation.error,
        variant: "destructive",
      });
      return;
    }

    // Store selected file for local preview
    setSelectedFile(file);

    // Create abort controller for cancellation
    const controller = new AbortController();
    setUploadController(controller);
    
    // Pre-upload optimizations
    setIsUploading(true);
    setUploadProgress(0);
    
    // Show immediate feedback
    toast({
      title: "Upload started",
      description: `Uploading ${file.name}...`,
    });
    
    try {
      // Silent authentication check - no user-facing messages
      const authCheck = await fetch('/api/auth/me', {
        credentials: 'include'
      });
      
      if (!authCheck.ok) {
        // Silent redirect to login without error toast
        console.log('Session expired, redirecting to login...');
        window.location.href = '/login?message=Session expired. Please log in again.';
        return;
      }
      
      const authData = await authCheck.json();
      console.log('Authentication confirmed for user:', authData.user?.email);
      
      // Optimized chunk sizing based on file size for maximum stability
      const fileSizeMB = Math.round(file.size / 1024 / 1024);
      const fileSizeGB = file.size / (1024 * 1024 * 1024);
      
      // Dynamic chunk sizing optimized for mobile stability
      let chunkSize = 5 * 1024 * 1024; // Default 5MB chunks (mobile-friendly)
      
      // Detect mobile/smaller devices for even smaller chunks
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                      window.innerWidth <= 768;
      
      if (isMobile) {
        // Mobile devices get smaller chunks for better reliability
        if (fileSizeGB > 5) chunkSize = 2 * 1024 * 1024;   // 2MB for large files on mobile
        else if (fileSizeMB > 500) chunkSize = 3 * 1024 * 1024;  // 3MB for medium files
        else chunkSize = 5 * 1024 * 1024;  // 5MB for smaller files
      } else {
        // Desktop gets larger chunks for efficiency
        if (fileSizeGB > 8) chunkSize = 5 * 1024 * 1024;   // 5MB for 8GB+ files
        else if (fileSizeGB > 5) chunkSize = 8 * 1024 * 1024;   // 8MB for 5GB+ files
        else if (fileSizeMB > 1000) chunkSize = 10 * 1024 * 1024;  // 10MB for 1GB+ files
        else if (fileSizeMB > 500) chunkSize = 10 * 1024 * 1024;  // 10MB for 500MB+ files
        else if (fileSizeMB > 200) chunkSize = 15 * 1024 * 1024;  // 15MB for 200MB+ files
      }
      
      // Lower threshold to avoid 413 errors - use chunked upload for most files
      const chunkThreshold = isMobile ? 10 * 1024 * 1024 : 25 * 1024 * 1024; // 10MB for mobile, 25MB for desktop
      const shouldUseChunkedUpload = file.size > chunkThreshold;

      // Calculate batch size for parallel uploads (same logic as uploadFileInChunks)
      const batchSize = isMobile
        ? (fileSizeGB > 5 ? 3 : 4)  // Mobile: 3-4 chunks in parallel
        : (fileSizeGB > 5 ? 5 : 6); // Desktop: 5-6 chunks in parallel

      let response: Response;

      if (shouldUseChunkedUpload) {
        const totalChunks = Math.ceil(file.size / chunkSize);
        console.log(`Large file detected (${fileSizeMB}MB), using direct-to-R2 upload...`);

        // Show detailed upload strategy to user
        const strategy = isMobile ? 'mobile-optimized' :
                        fileSizeGB > 8 ? 'maximum-stability' :
                        fileSizeGB > 5 ? 'ultra-stable' :
                        fileSizeMB > 1000 ? 'high-stability' :
                        fileSizeMB > 500 ? 'medium-stability' : 'fast-stable';

        const deviceNote = isMobile ? ` (${batchSize} parallel)` : ` (${batchSize} parallel - optimized)`;
        toast({
          title: "Preparing direct upload to R2",
          description: `${strategy} mode: ${totalChunks} parts of ${Math.round(chunkSize/1024/1024)}MB each${deviceNote} - ULTRA FAST!`,
        });

        response = await uploadDirectToR2(file, chunkSize, controller);
      } else {
        console.log('Regular upload for small file...');
        const formData = new FormData();
        formData.append('video', file);
        // Don't send metadata during upload - it will be updated after upload when user edits fields
        
        // Comprehensive pre-upload diagnostics
        try {
          const diagResponse = await fetch('/api/upload-diagnostics', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
          });
          
          if (!diagResponse.ok) {
            throw new Error(`Diagnostics failed: ${diagResponse.status}`);
          }
          
          const diagnostics = await diagResponse.json();
          console.log('🔧 Upload diagnostics:', diagnostics);
          
          if (diagnostics.status !== 'ready') {
            throw new Error('Upload service not ready');
          }
        } catch (diagError) {
          console.error('❌ Upload diagnostics failed:', diagError);
          throw new Error('Upload service temporarily unavailable. Please refresh and try again.');
        }

        // Debug authentication before upload
        console.log('🔐 Auth debug for direct upload:', {
          cookies: document.cookie,
          hasSession: document.cookie.includes('cutmv-session'),
          timestamp: new Date().toISOString(),
          fileSize: file.size,
          fileName: file.name
        });
        
        // Fast single upload for smaller files
        response = await new Promise<Response>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.timeout = 120000; // 2 minute timeout
          
          xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
              const progress = Math.round((event.loaded / event.total) * 100);
              setUploadProgress(progress);
            }
          });

          xhr.addEventListener('load', () => {
            console.log('📤 Upload response received:', {
              status: xhr.status,
              statusText: xhr.statusText,
              responseURL: xhr.responseURL,
              responseText: xhr.responseText.substring(0, 500) + '...',
              timestamp: new Date().toISOString(),
              headers: {
                contentType: xhr.getResponseHeader('content-type'),
                contentLength: xhr.getResponseHeader('content-length')
              }
            });
            
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(new Response(xhr.responseText, {
                status: xhr.status,
                statusText: xhr.statusText,
                headers: { 'Content-Type': 'application/json' }
              }));
            } else {
              const errorMsg = `HTTP ${xhr.status}: ${xhr.responseText || xhr.statusText}`;
              console.error('❌ Upload HTTP error:', errorMsg);
              reject(new Error(errorMsg));
            }
          });

          xhr.addEventListener('error', (event) => {
            console.error('❌ XHR error event:', event);
            console.error('❌ XHR state:', {
              readyState: xhr.readyState,
              status: xhr.status,
              statusText: xhr.statusText,
              responseText: xhr.responseText
            });
            reject(new Error(`Network error during upload: ${xhr.statusText || 'Connection failed'}`));
          });
          
          xhr.addEventListener('timeout', () => {
            console.error('❌ Upload timeout after 2 minutes');
            reject(new Error('Upload timeout - file too large or connection too slow'));
          });

          xhr.open('POST', '/api/upload');
          xhr.withCredentials = true; // Include cookies for authentication
          
          // Handle cancellation for regular uploads
          controller.signal.addEventListener('abort', () => {
            xhr.abort();
          });
          
          xhr.send(formData);
        });
      }

      console.log('Response received:', response.status);
      
      // Show processing state
      setIsUploading(false);
      setUploadProgress(0);
      setIsProcessingVideo(true);
      
      toast({
        title: "Upload complete!",
        description: "Processing video metadata...",
      });
      
      try {
        const video = await response.json();
        console.log('VideoUpload: Video object received from server:', video);
        console.log('VideoUpload: Video validation check:', {
          hasVideo: !!video,
          hasId: !!video?.id,
          hasOriginalName: !!video?.originalName,
          videoKeys: video ? Object.keys(video) : 'null'
        });
        
        // Validate the response has required fields
        if (!video || !video.id || !video.originalName) {
          console.error('VideoUpload: Invalid video data - missing required fields');
          throw new Error(`Invalid video data received from server. Missing: ${!video ? 'video object' : !video.id ? 'id' : 'originalName'}`);
        }
        
        console.log('VideoUpload: About to call onVideoUpload callback');
        console.log('VideoUpload: onVideoUpload function exists:', typeof onVideoUpload === 'function');
        
        // Call the callback to notify parent component
        try {
          console.log('VideoUpload: Calling onVideoUpload with video data:', {
            id: video.id,
            originalName: video.originalName,
            filename: video.filename
          });
          onVideoUpload(video);
          console.log('VideoUpload: onVideoUpload callback completed successfully');
        } catch (callbackError: any) {
          console.error('VideoUpload: onVideoUpload callback failed:', callbackError);
          console.error('VideoUpload: Full callback error details:', {
            error: callbackError,
            stack: callbackError?.stack,
            video: video
          });
          throw new Error(`Failed to update parent component with video data: ${callbackError?.message}`);
        }
        
        setIsProcessingVideo(false);
        
        toast({
          title: "Video ready!",
          description: `${file.name} is ready for processing.`,
        });
        
      } catch (videoProcessingError: any) {
        console.error('Failed to process video response:', videoProcessingError);
        console.error('VideoUpload: Full error details:', {
          error: videoProcessingError,
          errorMessage: videoProcessingError?.message,
          errorStack: videoProcessingError?.stack,
          responseStatus: response?.status,
          responseOk: response?.ok
        });
        setIsProcessingVideo(false);
        
        // Don't throw error here - this prevents the outer catch from showing "upload failed"
        // The upload succeeded, just the video processing response had issues
        toast({
          title: "Upload succeeded, processing issue",
          description: `Response processing failed: ${videoProcessingError?.message || 'Unknown error'}. Check console for details.`,
          variant: "destructive",
        });
        
        // Return early to prevent outer catch block from executing
        return;
      }
    } catch (error: any) {
      console.error('Upload error:', error);
      
      // Handle cancellation gracefully
      if (error.name === 'AbortError' || (error instanceof Error && error.message.includes('abort'))) {
        // Upload was cancelled, don't show error toast
        return;
      }
      
      let errorMessage = "Failed to upload video. Please try again.";

      // Enhanced error logging for debugging
      console.error('❌ Upload error details:', {
        errorType: error.constructor.name,
        errorMessage: error.message,
        errorStack: error.stack,
        authStatus: authStatus,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        connectionType: (navigator as any).connection?.effectiveType || 'unknown'
      });

      // Check for authentication errors and handle silently
      if (error instanceof Error && (
        error.message.includes('401') ||
        error.message.includes('Authentication required') ||
        error.message.includes('Not authenticated') ||
        error.message.includes('Invalid session') ||
        error.message.includes('Session expired')
      )) {
        // Silent redirect for auth errors - no toast shown
        console.log('Authentication error detected, redirecting to login...');
        window.location.href = '/login?message=Session expired. Please log in again.';
        return;
      } else if (error instanceof Error && (
        error.message.includes('refresh') ||
        error.message.includes('Unexpected token') ||
        error.message.includes('SyntaxError') ||
        error.message.includes('not valid JSON')
      )) {
        // Stale code or server error - suggest refresh
        errorMessage = 'Upload failed. Please refresh the page (Cmd+Shift+R or Ctrl+Shift+R) and try again.';
      } else if (error instanceof Error && error.message.includes(':')) {
        // Try to extract the error message from the server response
        const messagePart = error.message.split(': ')[1];
        try {
          const errorData = JSON.parse(messagePart);
          if (errorData.message) {
            errorMessage = errorData.message;
          }
        } catch {
          // If parsing fails, use the part after the colon
          errorMessage = messagePart || errorMessage;
        }
      }
      
      // Only show upload failed toast for actual upload errors
      if (!error.message.includes('Failed to process uploaded video data')) {
        toast({
          title: "Upload failed",
          description: errorMessage,
          variant: "destructive",
        });
      }
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      setIsProcessingVideo(false);
      setUploadController(null);
    }
  }, [onVideoUpload, toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'video/mp4': ['.mp4'],
      'video/quicktime': ['.mov'],
      'video/x-matroska': ['.mkv']
    },
    maxFiles: 1,
    multiple: false,
    maxSize: SECURITY_CONFIG.MAX_FILE_SIZE,
    // Remove disabled properties to allow button functionality
    // We'll handle upload prevention with overlay instead
  });

  const handleRemoveVideo = async () => {
    if (!uploadedVideo) return;

    try {
      // Delete the video from server
      await apiRequest("DELETE", `/api/videos/${uploadedVideo.id}`);

      // Clear selected file and preview
      setSelectedFile(null);

      // Call the callback with null to clear the video state
      onVideoUpload(null as any);

      toast({
        title: "Video deleted",
        description: "Video has been removed successfully.",
      });
    } catch (error) {
      console.error('Delete error:', error);
      toast({
        title: "Delete failed",
        description: "Failed to delete video. Please try again.",
        variant: "destructive",
      });
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (uploadedVideo) {
    console.log('📹 Rendering uploaded video with preview:', {
      hasUploadedVideo: !!uploadedVideo,
      hasVideoPreviewUrl: !!videoPreviewUrl,
      videoPreviewUrl,
      hasSelectedFile: !!selectedFile,
      selectedFileName: selectedFile?.name
    });

    return (
      <div className="space-y-6">
        {/* Video Info Card with Preview */}
        <div className="flex items-center space-x-4 p-4 bg-gray-50 rounded-lg">
          {/* Video Preview Thumbnail */}
          <div className="w-24 h-24 bg-gray-300 rounded-lg overflow-hidden flex-shrink-0">
            {videoPreviewUrl ? (
              <video
                src={videoPreviewUrl}
                className="w-full h-full object-cover"
                preload="metadata"
                muted
                playsInline
                onLoadedData={() => console.log('✅ Video preview loaded successfully')}
                onError={(e) => console.error('❌ Video preview failed to load:', e)}
              >
                Your browser does not support video preview
              </video>
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gray-300">
                <Play className="text-gray-600" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-gray-900 truncate">{uploadedVideo.originalName}</h4>
            <p className="text-sm text-gray-500">
              Duration: {uploadedVideo.duration || 'Processing...'} • Size: {formatFileSize(uploadedVideo.size)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemoveVideo}
            className="text-red-600 hover:text-red-700 flex-shrink-0"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {/* Metadata fields - editable after upload */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="videoTitle" className="text-sm font-medium">
              Video Title <span className="text-gray-400">(optional)</span>
            </Label>
            <Input
              id="videoTitle"
              type="text"
              placeholder="e.g., Dreams Come True"
              value={videoTitle}
              onChange={(e) => {
                setVideoTitle(e.target.value);
                // Update database when user types
                if (uploadedVideo?.id) {
                  updateVideoMetadata(uploadedVideo.id, e.target.value, artistInfo);
                }
              }}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="artistInfo" className="text-sm font-medium">
              Artist / Song Info <span className="text-gray-400">(optional)</span>
            </Label>
            <Input
              id="artistInfo"
              type="text"
              placeholder="e.g., Artist — Song Title"
              value={artistInfo}
              onChange={(e) => {
                setArtistInfo(e.target.value);
                // Update database when user types
                if (uploadedVideo?.id) {
                  updateVideoMetadata(uploadedVideo.id, videoTitle, e.target.value);
                }
              }}
              className="mt-1"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Upload area */}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors relative ${
          (isUploading || isProcessingVideo)
            ? 'border-gray-200 bg-gray-50 cursor-not-allowed opacity-75' 
            : isDragActive 
              ? 'bg-green-50 cursor-pointer'
              : 'border-gray-300 hover:cursor-pointer'
        }`}
        style={isDragActive ? { borderColor: 'hsl(85, 70%, 55%)' } : {}}
        onClick={(isUploading || isProcessingVideo) ? (e) => e.preventDefault() : undefined}
      >
        <input {...getInputProps()} />
      
      {/* Overlay to prevent any interactions during upload/processing except cancel button */}
      {(isUploading || isProcessingVideo) && (
        <div 
          className="absolute inset-0 bg-transparent cursor-not-allowed z-10"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }}
        />
      )}
      
      {isUploading ? (
        <div className="flex flex-col items-center relative z-20">
          {/* Upload in progress indicator */}
          <Upload className="text-4xl mb-4 animate-pulse" style={{ color: 'hsl(85, 70%, 55%)' }} />
          <p className="text-lg font-medium text-gray-700 mb-2">Upload in Progress</p>
          <div className="w-full max-w-xs mb-2">
            <div className="bg-gray-200 rounded-full h-2">
              <div 
                className="h-2 rounded-full transition-all duration-300"
                style={{ 
                  width: `${uploadProgress}%`,
                  backgroundColor: 'hsl(85, 70%, 55%)'
                }}
              ></div>
            </div>
            <p className="text-xs text-gray-500 mt-1 text-center">{uploadProgress}%</p>
          </div>
          <div className="text-center mb-4">
            <p className="text-sm text-gray-600 mb-2">Please do not close this page or upload another file</p>
            <p className="text-xs text-amber-600 font-medium bg-amber-50 px-3 py-1 rounded-full inline-block">
              🔒 Upload area disabled during transfer
            </p>
          </div>
          <Button 
            variant="outline" 
            onClick={cancelUpload}
            className="border-red-300 text-red-600 hover:bg-red-50 relative z-20"
          >
            Cancel Upload
          </Button>
        </div>
      ) : isProcessingVideo ? (
        <div className="flex flex-col items-center relative z-20">
          {/* Video processing indicator */}
          <Video className="text-4xl text-blue-600 mb-4 animate-pulse" />
          <p className="text-lg font-medium text-gray-700 mb-2">Processing Video</p>
          <div className="w-full max-w-xs mb-2">
            <div className="bg-gray-200 rounded-full h-2">
              <div className="bg-blue-600 h-2 rounded-full animate-pulse w-full"></div>
            </div>
          </div>
          <div className="text-center mb-4">
            <p className="text-sm text-gray-600 mb-2">Extracting video metadata and preparing for processing...</p>
            <p className="text-xs text-blue-600 font-medium bg-blue-50 px-3 py-1 rounded-full inline-block">
              ⚡ Almost ready!
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <Video className="text-4xl text-gray-400 mb-4" />
          <p className="text-lg font-medium text-gray-700 mb-2">
            {isDragActive ? "Drop your video here" : "Drop your video here or click to browse"}
          </p>
          <p className="text-sm text-gray-500 mb-2">Supports .mp4, .mov, .mkv (up to 10GB)</p>
          <p className="text-xs text-gray-400 mb-4 flex items-center justify-center gap-1">
            <Shield className="w-3 h-3" />
            Secure upload with file validation
          </p>
          <Button 
            className="text-white hover:opacity-90"
            style={{ backgroundColor: 'hsl(85, 70%, 55%)' }}
            onClick={() => {
              const input = document.querySelector('input[type="file"]') as HTMLInputElement;
              if (input) input.click();
            }}
            type="button"
          >
            Choose File
          </Button>
        </div>
      )}
      </div>
    </div>
  );
}
