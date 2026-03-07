/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Complete routes implementation with all video processing functionality
 */

import express, { type Express, type Request } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import ffmpeg from "fluent-ffmpeg";
import Stripe from "stripe";
import { insertVideoSchema, timestampListSchema, paymentRequestSchema, promoCodeValidationSchema } from "@shared/schema";
import crypto from "crypto";
import { execSync } from "child_process";
import R2Storage from "./r2-storage";
import { ffmpegProcessor } from './ffmpeg-progress.js';
import { enhancedProcessor } from './enhanced-process.js';
import { universalProgress } from './accurate-progress.js';
import { backgroundJobManager } from './background-job-manager.js';
import { emailService } from './email-service.js';
import type { WelcomeEmailOptions } from './email-service.js';
import { verifyEmailEndpoint } from './api/verify-email';
import { emailVerificationService } from './email-verification';
import { feedbackService } from './feedback-service';
import { FeedbackSubmissionSchema } from '../shared/feedback-schema';
import { supportService } from './support-service';
import { SupportSubmissionSchema } from '../shared/support-schema';
import { logUserEvent, logVideoProcessing, logEmailEvent, captureException } from './sentry';
import { aiMetadataService } from './ai-metadata-service.js';
import { blogService } from './blog-service.js';
import { promoCodeService } from './services/promoCodeService.js';
import { urlSecurity } from './url-security.js';
import { AuthService } from './auth-service';
import { requireAuth, optionalAuth } from './auth-middleware';
import { TimeEstimationService } from '../shared/time-estimation.js';
import { creditService } from './services/credit-service.js';
import { subscriptionService } from './services/subscription-service.js';

// Initialize auth service instance
const authService = new AuthService();

// Initialize Stripe for billing with graceful fallback
let stripe: Stripe | null = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-07-30.basil",
    });
    console.log('💳 Stripe payment processing initialized');
  } else {
    console.warn('⚠️ Stripe not configured - payment features disabled');
  }
} catch (error) {
  console.error('❌ Failed to initialize Stripe:', error);
  console.warn('⚠️ Payment features will be disabled');
}

// **R2-ONLY UPLOAD CONFIGURATION** - NO LOCAL STORAGE
// Multer configured to use memory storage - files never touch disk
const upload = multer({
  storage: multer.memoryStorage(), // CRITICAL: Memory only, no local files
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB limit
    fieldSize: 100 * 1024 * 1024, // 100MB field size for metadata
    fields: 10, // Allow multiple form fields
    files: 1, // Only one file at a time
    parts: 1000, // Allow many form parts
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'video/mp4', 
      'video/quicktime', 
      'video/x-msvideo', 
      'video/webm',
      'video/x-matroska',
      'video/avi',
      'video/3gpp',
      'video/3gpp2',
      'application/octet-stream' // Mobile browsers sometimes report this
    ];
    const allowedExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
    const fileExtension = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
    
    console.log(`📁 R2-direct upload attempt: ${file.originalname}, MIME: ${file.mimetype}, Extension: ${fileExtension}`);
    
    if (allowedMimes.includes(file.mimetype) || allowedExtensions.includes(fileExtension)) {
      console.log(`✅ File accepted for R2 upload: ${file.originalname}`);
      cb(null, true);
    } else {
      console.log(`❌ File rejected: ${file.originalname}, MIME: ${file.mimetype}, Extension: ${fileExtension}`);
      cb(new Error('Invalid file type. Only video files are allowed.'));
    }
  },
});

// Chunk store for resumable uploads
interface ChunkUpload {
  uploadId: string;
  fileName: string;
  totalSize: number;
  chunks: Buffer[];
  receivedSize: number;
  completed: boolean;
  videoTitle?: string;
  artistInfo?: string;
}

const chunkStore = new Map<string, ChunkUpload>();

// Helper function to format duration from seconds to MM:SS
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  
  // Initialize WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  
  console.log("✅ Registering complete routes with video processing functionality...");
  
  // NO DEV LOGIN ROUTES - User must use production authentication only
  
  // WebSocket connection handling with error handling
  wss.on('connection', (ws, req) => {
    console.log('🔌 WebSocket client connected');
    
    // Handle connection errors
    ws.on('error', (error) => {
      console.log('🔌 WebSocket connection error (handled):', error.message);
    });
    
    ws.on('close', (code, reason) => {
      console.log('🔌 WebSocket connection closed:', code, reason?.toString());
    });
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log('📡 WebSocket message:', data.type);
        
        // Handle video ID registration for progress updates
        if (data.type === 'register' && data.videoId) {
          ffmpegProcessor.registerWebSocket(data.videoId, ws);
          console.log(`📡 Registered WebSocket for video ${data.videoId}`);
        }
      } catch (error) {
        console.error('WebSocket message parsing error:', error);
      }
    });
    
    ws.on('close', () => {
      console.log('📡 Client disconnected');
    });
  });
  
  // Enhanced test endpoint with full functionality check
  app.get('/api/test', (req, res) => {
    res.json({ 
      message: 'Complete routes working with full processing capabilities', 
      timestamp: new Date().toISOString(),
      capabilities: {
        videoUpload: true,
        backgroundProcessing: true,
        emailNotifications: true,
        progressTracking: true,
        r2Storage: !!process.env.R2_ACCESS_KEY_ID
      }
    });
  });

  // Test promo processing endpoint (for debugging)
  app.post('/api/test/promo-processing', async (req, res) => {
    try {
      const { userEmail, videoId, sessionId, processingOptions } = req.body;
      
      console.log(`🧪 Testing promo processing for ${userEmail}, video ${videoId}`);
      
      const jobResult = await backgroundJobManager.createJob(sessionId, videoId, userEmail, {
        ...processingOptions,
        timestampText: processingOptions.timestampText || '0:10-0:20'
      });
      
      if (jobResult.success) {
        res.json({ success: true, message: 'Test processing started', jobId: jobResult.jobId });
      } else {
        res.json({ success: false, error: jobResult.error });
      }
    } catch (error) {
      console.error('Test processing error:', error);
      res.status(500).json({ error: 'Test failed' });
    }
  });

  // Background job diagnostic endpoint (no auth for debugging)
  app.get('/api/debug/jobs/:userEmail', async (req, res) => {
    try {
      const { userEmail } = req.params;
      
      // Get user's background jobs
      const userJobs = await storage.getUserBackgroundJobs(userEmail);
      const userVideos = await storage.getUserVideos(userEmail);
      
      console.log(`🔍 Debug jobs for ${userEmail}:`, {
        jobsCount: userJobs.length,
        videosCount: userVideos.length
      });
      
      res.json({
        userEmail,
        timestamp: new Date().toISOString(),
        jobs: userJobs.map(j => ({
          id: j.id,
          sessionId: j.sessionId,
          status: j.status,
          progress: j.progress,
          videoId: j.videoId,
          downloadPath: j.downloadPath,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
          errorMessage: j.errorMessage
        })),
        videos: userVideos.map(v => ({
          id: v.id,
          originalName: v.originalName,
          r2Key: v.r2Key,
          userEmail: v.userEmail
        }))
      });
    } catch (error) {
      console.error('Debug jobs error:', error);
      res.status(500).json({ error: 'Debug failed' });
    }
  });

  // R2 Storage diagnostic endpoint
  app.post('/api/r2-test', async (req, res) => {
    try {
      const testContent = `R2 Test Upload - ${new Date().toISOString()}`;
      const testBuffer = Buffer.from(testContent, 'utf8');
      const testKey = `test-uploads/r2-diagnostic-${Date.now()}.txt`;
      
      console.log(`🧪 R2 Diagnostic Test: Uploading ${testBuffer.length} bytes to ${testKey}`);
      
      // Direct R2 upload test
      await R2Storage.uploadBuffer(testBuffer, testKey, 'text/plain', 'diagnostic-test@example.com');
      
      // Verify upload by generating signed URL
      const signedUrl = await R2Storage.getSignedUrl(testKey, 300);
      console.log(`🔍 Testing signed URL: ${signedUrl.substring(0, 100)}...`);
      
      // Test the signed URL
      const testResponse = await fetch(signedUrl);
      const retrievedContent = await testResponse.text();
      
      const uploadWorking = testResponse.ok && retrievedContent === testContent;
      
      res.json({
        success: true,
        uploadWorking,
        testKey,
        signedUrl: signedUrl.substring(0, 100) + '...',
        retrievedContent: retrievedContent.substring(0, 50) + '...',
        statusCode: testResponse.status
      });
      
      // Clean up test file
      setTimeout(() => R2Storage.deleteFile(testKey), 5000);
      
    } catch (error) {
      console.error('R2 diagnostic test failed:', error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });
  
  // Health check endpoint - comprehensive version with processing status
  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      server: 'complete routes with processing',
      timestamp: new Date().toISOString(),
      features: {
        videoProcessing: true,
        backgroundJobs: true,
        emailDelivery: true,
        r2Storage: !!process.env.R2_ACCESS_KEY_ID
      }
    });
  });

  // Upload endpoint health check
  app.get('/api/upload-test', requireAuth, (req, res) => {
    res.json({ 
      status: 'ok', 
      message: 'Upload endpoint ready',
      userEmail: req.user?.email,
      timestamp: new Date().toISOString()
    });
  });

  // Comprehensive upload diagnostics
  app.post('/api/upload-diagnostics', requireAuth, (req, res) => {
    res.json({
      status: 'ready',
      user: req.user?.email,
      server: {
        timestamp: new Date().toISOString(),
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
      },
      multer: {
        configured: true,
        maxFileSize: 10 * 1024 * 1024 * 1024,
        storage: 'memory'
      },
      r2: {
        configured: !!process.env.R2_ACCESS_KEY_ID,
        bucket: process.env.R2_BUCKET_NAME || 'not-set'
      },
      headers: {
        contentType: req.get('content-type'),
        userAgent: req.get('user-agent')?.substring(0, 100),
        contentLength: req.get('content-length')
      }
    });
  });

  // Pricing endpoint - returns subscriber-aware pricing
  // Subscribers get 50% off (base rates), non-subscribers pay 2×
  app.get("/api/pricing", optionalAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const isSubscriber = userId ? await creditService.isActiveSubscriber(userId) : false;
      const multiplier = isSubscriber ? 1 : 2;

      // Base subscriber rates (from CREDIT_COSTS)
      const subscriberRates = {
        cutdown: 50,          // Per cutdown
        gifPack: 90,          // GIF pack (10 GIFs)
        thumbnailPack: 90,    // Thumbnail pack (10 thumbnails)
        canvasPack: 225       // Spotify Canvas pack (5 loops)
      };

      // Non-subscriber rates (2×)
      const nonSubscriberRates = {
        cutdown: 100,
        gifPack: 180,
        thumbnailPack: 180,
        canvasPack: 450
      };

      res.json({
        // Applied rates based on user's subscription status
        cutdown: subscriberRates.cutdown * multiplier,
        gifPack: subscriberRates.gifPack * multiplier,
        thumbnailPack: subscriberRates.thumbnailPack * multiplier,
        canvasPack: subscriberRates.canvasPack * multiplier,

        // User's subscription info
        isSubscriber,
        subscriberDiscount: isSubscriber ? 50 : 0, // Percentage saved

        // Both rate tables for UI display
        subscriberRates,
        nonSubscriberRates,

        // Legacy fields for backwards compatibility
        cutdown16x9: subscriberRates.cutdown * multiplier,
        cutdown9x16: subscriberRates.cutdown * multiplier,
        spotifyCanvas: subscriberRates.canvasPack * multiplier
      });
    } catch (error) {
      console.error('Error getting pricing:', error);
      res.status(500).json({ error: 'Failed to get pricing' });
    }
  });

  // ============================================================================
  // DIRECT-TO-R2 MULTIPART UPLOAD ENDPOINTS (50-70% faster than proxied uploads)
  // ============================================================================

  // Upload rate limiting to prevent R2 contention
  const activeUploads = new Map<string, Set<string>>(); // userEmail -> Set of uploadIds
  const UPLOAD_LIMITS = {
    PER_USER: 2,  // Max 2 concurrent uploads per user
    GLOBAL: 10    // Max 10 concurrent uploads across all users
  };

  function getActiveUploadCount(): number {
    let total = 0;
    activeUploads.forEach(uploads => total += uploads.size);
    return total;
  }

  function trackUpload(userEmail: string, uploadId: string): void {
    if (!activeUploads.has(userEmail)) {
      activeUploads.set(userEmail, new Set());
    }
    activeUploads.get(userEmail)!.add(uploadId);
    console.log(`📊 Upload tracking: ${userEmail} has ${activeUploads.get(userEmail)!.size} active uploads (global: ${getActiveUploadCount()})`);
  }

  function untrackUpload(userEmail: string, uploadId: string): void {
    const userUploads = activeUploads.get(userEmail);
    if (userUploads) {
      userUploads.delete(uploadId);
      if (userUploads.size === 0) {
        activeUploads.delete(userEmail);
      }
      console.log(`📊 Upload untracked: ${userEmail} now has ${userUploads.size} active uploads (global: ${getActiveUploadCount()})`);
    }
  }

  /**
   * NEW: Initiate direct browser-to-R2 multipart upload
   * Returns presigned URLs for each chunk - browser uploads directly to R2
   */
  app.post('/api/initiate-multipart-upload', requireAuth, async (req, res) => {
    try {
      const { fileName, fileSize, totalChunks, existingUploadId, existingR2Key } = req.body;

      if (!fileName || !fileSize || !totalChunks) {
        return res.status(400).json({ error: 'fileName, fileSize, and totalChunks required' });
      }

      const userEmail = req.user?.email;
      if (!userEmail) {
        return res.status(401).json({ error: 'User email required' });
      }

      let uploadId: string;
      let r2Key: string;
      let isResume = false;

      // Support for resuming existing uploads
      if (existingUploadId && existingR2Key) {
        console.log(`🔄 Resuming multipart upload: ${fileName} (uploadId: ${existingUploadId})`);
        uploadId = existingUploadId;
        r2Key = existingR2Key;
        isResume = true;

        // Validate that the existing upload is still active
        // Note: We can't easily check if an upload ID is valid in R2 without attempting to use it
        // The presigned URL generation will fail if the upload ID is invalid
      } else {
        // Rate limiting: Check concurrent upload limits for NEW uploads only
        const userUploads = activeUploads.get(userEmail);
        const userUploadCount = userUploads ? userUploads.size : 0;
        const globalUploadCount = getActiveUploadCount();

        if (userUploadCount >= UPLOAD_LIMITS.PER_USER) {
          console.log(`⛔ Rate limit: User ${userEmail} has ${userUploadCount} active uploads (limit: ${UPLOAD_LIMITS.PER_USER})`);
          return res.status(429).json({
            error: 'Upload limit exceeded',
            message: `You can only have ${UPLOAD_LIMITS.PER_USER} concurrent uploads. Please wait for one to complete.`,
            activeUploads: userUploadCount,
            limit: UPLOAD_LIMITS.PER_USER
          });
        }

        if (globalUploadCount >= UPLOAD_LIMITS.GLOBAL) {
          console.log(`⛔ Rate limit: Global upload count ${globalUploadCount} exceeds limit ${UPLOAD_LIMITS.GLOBAL}`);
          return res.status(503).json({
            error: 'Service busy',
            message: 'Too many concurrent uploads. Please try again in a few moments.',
            estimatedWaitSeconds: 60
          });
        }

        console.log(`🚀 Initiating NEW direct-to-R2 multipart upload: ${fileName} (${fileSize} bytes, ${totalChunks} chunks)`);
        console.log(`📊 Current upload load: user ${userUploadCount}/${UPLOAD_LIMITS.PER_USER}, global ${globalUploadCount}/${UPLOAD_LIMITS.GLOBAL}`);

        // Generate R2 key for this upload
        r2Key = R2Storage.generateR2Key(fileName, 'uploads', userEmail);

        // Create multipart upload in R2
        uploadId = await R2Storage.createMultipartUpload(r2Key, 'video/mp4', userEmail);

        // Track this upload for rate limiting
        trackUpload(userEmail, uploadId);
      }

      // Generate fresh presigned URLs for each part (12 hours expiry for large files)
      // These are always generated fresh to ensure they're not expired
      const presignedUrls = await R2Storage.generatePresignedPartUrls(
        r2Key,
        uploadId,
        totalChunks,
        43200 // 12 hours - allows time for large uploads on slow connections
      );

      console.log(`✅ Generated ${presignedUrls.length} presigned URLs for ${existingUploadId ? 'RESUMED' : 'NEW'} upload (valid for 12 hours)`);

      res.json({
        success: true,
        uploadId, // R2 multipart upload ID
        r2Key, // For completion call
        presignedUrls, // Browser will upload to these URLs directly
        expiresIn: 43200, // URLs valid for 12 hours
        resumed: !!existingUploadId, // Indicate if this is a resumed upload
      });
    } catch (error) {
      console.error('❌ Multipart upload initiation failed:', error);
      res.status(500).json({
        error: 'Failed to initiate multipart upload',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * NEW: Complete direct browser-to-R2 multipart upload
   * Browser provides ETags from each part upload
   */
  app.post('/api/complete-multipart-upload', requireAuth, async (req, res) => {
    try {
      const { uploadId, r2Key, parts, videoTitle, artistInfo, fileName } = req.body;

      if (!uploadId || !r2Key || !parts || !Array.isArray(parts)) {
        return res.status(400).json({ error: 'uploadId, r2Key, and parts[] required' });
      }

      console.log(`✅ Completing multipart upload: ${r2Key} with ${parts.length} parts`);

      const userEmail = req.user?.email;
      if (!userEmail) {
        return res.status(401).json({ error: 'User email required' });
      }

      // Complete the multipart upload in R2
      await R2Storage.completeMultipartUpload(r2Key, uploadId, parts);

      console.log(`✅ R2 multipart upload completed successfully`);

      // Now create video record in database
      const r2Url = await R2Storage.getSignedUrl(r2Key, 3600);

      const video = await storage.createVideo({
        filename: fileName || r2Key.split('/').pop() || 'unknown',
        originalName: fileName || r2Key.split('/').pop() || 'unknown',
        path: r2Key,
        r2Key: r2Key,
        r2Url: r2Url,
        size: parts.reduce((sum: number) => sum + 1, 0), // Will be updated after metadata extraction
        videoTitle: videoTitle || null,
        artistInfo: artistInfo || null,
        userEmail: userEmail,
        sessionId: null,
      });

      console.log(`📊 Video record created: ${video.id}`);

      // Extract metadata using ffprobe (same method as legacy upload)
      let finalVideo = video;
      try {
        console.log(`📊 Starting metadata extraction for ${r2Key}`);

        // Use ffprobe on R2 signed URL (same as legacy endpoint)
        const metadata = await new Promise<any>((resolve, reject) => {
          ffmpeg.ffprobe(r2Url!, ['-v', 'quiet', '-show_format', '-show_streams'], (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata);
          });
        });

        const duration = metadata?.format?.duration ? formatDuration(metadata.format.duration) : null;
        const videoStream = metadata?.streams?.find((stream: any) => stream.codec_type === 'video');
        const width = videoStream?.width;
        const height = videoStream?.height;

        let aspectRatio = '16:9';
        if (width && height) {
          const ratio = width / height;
          aspectRatio = ratio < 0.75 ? '9:16' : '16:9';
        }

        console.log(`✅ Video analysis complete:`, { duration, width, height, aspectRatio });

        // Get actual file size from R2
        const tempBuffer = await R2Storage.downloadFile(r2Key);
        const actualSize = tempBuffer.length;

        console.log(`💾 Updating video record with metadata...`);
        const updatedVideo = await storage.updateVideo(video.id, {
          duration,
          width,
          height,
          aspectRatio,
          size: actualSize,
        });

        finalVideo = updatedVideo || video;
        console.log(`✅ Video metadata extracted and updated successfully:`, {
          duration: finalVideo.duration,
          aspectRatio: finalVideo.aspectRatio,
          size: finalVideo.size
        });
      } catch (metadataError) {
        console.error('❌ Metadata extraction failed:', {
          error: metadataError,
          message: metadataError instanceof Error ? metadataError.message : String(metadataError),
          stack: metadataError instanceof Error ? metadataError.stack : undefined,
          r2Key
        });
        // Continue with original video object (without metadata)
      }

      // Untrack upload from rate limiting
      untrackUpload(userEmail, uploadId);

      // Return video data in same format as legacy upload endpoint
      res.json({
        ...finalVideo,
        uploadId,
        accurateUpload: true,
      });
    } catch (error) {
      console.error('❌ Multipart upload completion failed:', error);

      // Untrack upload even on error
      const userEmail = req.user?.email;
      const { uploadId } = req.body;
      if (userEmail && uploadId) {
        untrackUpload(userEmail, uploadId);
      }

      res.status(500).json({
        error: 'Failed to complete multipart upload',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * NEW: Abort multipart upload (cleanup on error/cancel)
   */
  app.post('/api/abort-multipart-upload', requireAuth, async (req, res) => {
    try {
      const { uploadId, r2Key } = req.body;

      if (!uploadId || !r2Key) {
        return res.status(400).json({ error: 'uploadId and r2Key required' });
      }

      const userEmail = req.user?.email;
      if (!userEmail) {
        return res.status(401).json({ error: 'User email required' });
      }

      console.log(`🗑️ Aborting multipart upload: ${r2Key}`);

      await R2Storage.abortMultipartUpload(r2Key, uploadId);

      // Untrack upload from rate limiting
      untrackUpload(userEmail, uploadId);

      res.json({ success: true });
    } catch (error) {
      console.error('⚠️ Abort multipart upload error:', error);

      // Untrack upload even on error
      const userEmail = req.user?.email;
      const { uploadId } = req.body;
      if (userEmail && uploadId) {
        untrackUpload(userEmail, uploadId);
      }

      // Return success anyway - cleanup is best-effort
      res.json({ success: true });
    }
  });

  // ============================================================================
  // LEGACY UPLOAD ENDPOINTS (kept for backwards compatibility)
  // ============================================================================

  // Video upload endpoints
  app.post('/api/initiate-upload', requireAuth, async (req, res) => {
    try {
      const { fileName, fileSize, videoTitle, artistInfo } = req.body;
      
      if (!fileName || !fileSize) {
        return res.status(400).json({ error: 'File name and size required' });
      }
      
      // Generate upload ID
      const uploadId = Math.random().toString(36).substring(7);
      
      // Return upload configuration
      // Mobile-optimized chunk sizes
      const userAgent = req.get('User-Agent') || '';
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
      const chunkSize = isMobile ? 5 * 1024 * 1024 : 10 * 1024 * 1024; // 5MB for mobile, 10MB for desktop
      
      res.json({
        success: true,
        uploadId,
        chunkSize,
        maxRetries: 3
      });
      
    } catch (error) {
      console.error('Upload initiation error:', error);
      res.status(500).json({ error: 'Failed to initiate upload' });
    }
  });

  app.post('/api/upload-chunk', requireAuth, express.raw({ limit: '50mb', type: 'application/octet-stream' }), async (req, res) => {
    try {
      const { uploadId, fileName, chunkIndex, totalChunks, totalSize, videoTitle, artistInfo } = req.query;
      
      if (!uploadId || !fileName || !req.body) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }

      const uploadIdStr = uploadId as string;
      const fileNameStr = fileName as string;
      const chunkIndexNum = parseInt(chunkIndex as string);
      const totalChunksNum = parseInt(totalChunks as string);
      const totalSizeNum = parseInt(totalSize as string);

      // Initialize upload if first chunk
      if (!chunkStore.has(uploadIdStr)) {
        chunkStore.set(uploadIdStr, {
          uploadId: uploadIdStr,
          fileName: fileNameStr,
          totalSize: totalSizeNum,
          chunks: new Array(totalChunksNum),
          receivedSize: 0,
          completed: false,
          videoTitle: videoTitle as string,
          artistInfo: artistInfo as string,
        });
        
        universalProgress.updateUploadProgress(uploadIdStr, 0, `Starting upload of ${fileNameStr}`);
      }

      const upload = chunkStore.get(uploadIdStr)!;
      upload.chunks[chunkIndexNum] = req.body as Buffer;
      upload.receivedSize += (req.body as Buffer).length;

      // Update progress
      universalProgress.updateUploadProgress(uploadIdStr, upload.receivedSize, `Uploading chunk ${chunkIndexNum + 1}/${totalChunksNum}`);

      // Check if all chunks received
      const allChunksReceived = upload.chunks.every(chunk => chunk !== undefined);
      
      if (allChunksReceived) {
        upload.completed = true;
        universalProgress.updateUploadProgress(uploadIdStr, upload.totalSize, 'Assembling file...');
      }

      res.json({ 
        success: true, 
        chunkIndex: chunkIndexNum,
        completed: allChunksReceived 
      });

    } catch (error) {
      console.error('Chunk upload error:', error);
      res.status(500).json({ error: 'Chunk upload failed' });
    }
  });

  // Finalize upload endpoint (alias for upload-complete for client compatibility)
  app.post('/api/finalize-upload', requireAuth, async (req, res) => {
    try {
      const { uploadId, videoTitle, artistInfo } = req.body;

      console.log('📝 Finalize-upload received:', { uploadId, videoTitle, artistInfo });

      if (!uploadId) {
        return res.status(400).json({ error: 'Upload ID required' });
      }

      const upload = chunkStore.get(uploadId);
      if (!upload || !upload.completed) {
        return res.status(400).json({ error: 'Upload not found or incomplete' });
      }

      // Update metadata from finalize request (takes precedence over chunk metadata)
      if (videoTitle !== undefined) {
        upload.videoTitle = videoTitle;
        console.log(`✅ Set upload.videoTitle to: ${videoTitle}`);
      }
      if (artistInfo !== undefined) {
        upload.artistInfo = artistInfo;
        console.log(`✅ Set upload.artistInfo to: ${artistInfo}`);
      }

      // **R2-ONLY ASSEMBLY** - Assemble chunks in memory and upload directly to R2 - NO LOCAL FILES
      const assembledBuffer = Buffer.concat(upload.chunks);
      console.log(`📦 Assembled ${assembledBuffer.length} bytes in memory for ${upload.fileName}`);
      
      universalProgress.updateUploadProgress(uploadId, upload.totalSize, 'Uploading to R2...');
      
      // Upload directly to R2 using buffer - NO LOCAL STORAGE
      let r2Key: string | undefined;
      let r2Url: string | undefined;
      
      try {
        // Ensure complete user folder structure exists before upload
        if (req.user?.email) {
          const clientIP = req.ip || req.connection.remoteAddress || 'Unknown';
          const userAgent = req.get('User-Agent') || 'Unknown';
          await R2Storage.ensureUserFolderStructure(req.user.email, clientIP, userAgent);
        }
        
        r2Key = R2Storage.generateR2Key(upload.fileName, 'uploads', req.user?.email);
        console.log(`🚀 Direct R2 buffer upload: ${upload.fileName} -> ${r2Key}`);
        await R2Storage.uploadBuffer(assembledBuffer, r2Key, 'video/mp4', req.user?.email);
        r2Url = await R2Storage.getSignedUrl(r2Key, 3600);
        console.log(`✅ Video successfully uploaded to R2: ${r2Key}`);
        
        // Log upload activity
        if (req.user?.email) {
          await R2Storage.logUserActivity(req.user.email, 'FILE_UPLOADED', {
            filename: upload.fileName,
            size: upload.totalSize,
            method: 'chunked_upload',
            r2Key: r2Key
          });
        }
      } catch (r2Error) {
        console.error(`❌ R2 upload failed for ${upload.fileName}:`, r2Error);
        console.error(`R2 Error details:`, {
          message: (r2Error as any).message,
          code: (r2Error as any).code,
          stack: (r2Error as any).stack?.split('\n')[0]
        });
        throw new Error(`Failed to upload to R2: ${(r2Error as any).message}`);
      }

      // Create video record with user email for proper authentication
      const userEmail = req.user?.email;
      console.log(`📊 Creating video record for user: ${userEmail || 'UNKNOWN'}`);
      
      if (!userEmail) {
        console.error('❌ CRITICAL: No user email found during video creation');
        throw new Error('User authentication required for video upload');
      }
      
      console.log(`📊 Creating video record with metadata:`, {
        videoTitle: upload.videoTitle || null,
        artistInfo: upload.artistInfo || null,
        filename: upload.fileName
      });

      const video = await storage.createVideo({
        filename: upload.fileName,
        originalName: upload.fileName,
        path: r2Key!, // R2 key is the "path" for processing
        r2Key: r2Key,
        r2Url: r2Url,
        size: upload.totalSize,
        videoTitle: upload.videoTitle || null,
        artistInfo: upload.artistInfo || null,
        userEmail: userEmail, // CRITICAL: Ensure user email is always set
      });

      console.log(`✅ Video created in database with user: ${userEmail}, ID: ${video.id}, title: ${video.videoTitle}, artist: ${video.artistInfo}`);

      // Extract video metadata from R2 using signed URL
      try {
        const metadata = await new Promise<any>((resolve, reject) => {
          ffmpeg.ffprobe(r2Url!, ['-v', 'quiet', '-show_format', '-show_streams'], (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata);
          });
        });

        const duration = metadata?.format?.duration ? formatDuration(metadata.format.duration) : null;
        const videoStream = metadata?.streams?.find((stream: any) => stream.codec_type === 'video');
        const width = videoStream?.width;
        const height = videoStream?.height;

        let aspectRatio = null;
        if (width && height) {
          const ratio = width / height;
          if (ratio > 1.5) {
            aspectRatio = '16:9';
          } else if (ratio < 0.75) {
            aspectRatio = '9:16';
          } else {
            aspectRatio = '16:9';
          }
        }

        if (duration) {
          const updatedVideo = await storage.updateVideo(video.id, { 
            duration,
            width,
            height,
            aspectRatio
          });
          
          universalProgress.updateUploadProgress(uploadId, upload.totalSize, 'Upload completed successfully');
          chunkStore.delete(uploadId);
          
          res.json({
            ...updatedVideo || video,
            uploadId,
            accurateUpload: true,
          });
        } else {
          universalProgress.updateUploadProgress(uploadId, upload.totalSize, 'Upload completed (no duration found)');
          chunkStore.delete(uploadId);
          
          res.json({
            ...video,
            uploadId,
            accurateUpload: true,
          });
        }
      } catch (error) {
        console.error('Metadata extraction error:', error);
        universalProgress.updateUploadProgress(uploadId, upload.totalSize, 'Upload completed (metadata extraction failed)');
        chunkStore.delete(uploadId);
        
        res.json({
          ...video,
          uploadId,
          accurateUpload: true,
        });
      }

    } catch (error) {
      console.error('Upload complete error:', error);
      res.status(500).json({ error: 'Upload completion failed' });
    }
  });

  // Update video metadata endpoint
  // Get video preview URL for uploaded video
  app.get('/api/videos/:id/preview', requireAuth, async (req, res) => {
    try {
      const videoId = parseInt(req.params.id);

      // Get the video to verify ownership
      const video = await storage.getVideo(videoId);
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }

      // Verify user owns this video
      if (video.userEmail !== req.user?.email) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Return R2 URL for preview
      if (video.r2Key) {
        const previewUrl = await R2Storage.getSignedUrl(video.r2Key, 3600); // 1 hour preview URL
        res.json({
          previewUrl,
          r2Url: previewUrl,
          videoId: video.id,
          originalName: video.originalName
        });
      } else {
        res.status(404).json({ error: 'Preview not available' });
      }
    } catch (error) {
      console.error('Failed to get video preview:', error);
      res.status(500).json({ error: 'Failed to get preview' });
    }
  });

  // Delete video endpoint
  app.delete('/api/videos/:id', requireAuth, async (req, res) => {
    try {
      const videoId = parseInt(req.params.id);

      console.log(`🗑️ Delete request for video ${videoId} by user ${req.user?.email}`);

      // Get the video to verify ownership
      const video = await storage.getVideo(videoId);
      if (!video) {
        console.log(`❌ Video ${videoId} not found`);
        return res.status(404).json({ error: 'Video not found' });
      }

      // Verify user owns this video
      if (video.userEmail !== req.user?.email) {
        console.log(`❌ User ${req.user?.email} does not own video ${videoId} (owner: ${video.userEmail})`);
        return res.status(403).json({ error: 'Access denied - you do not own this video' });
      }

      // Delete from R2 if it exists
      if (video.r2Key) {
        try {
          console.log(`🗑️ Deleting from R2: ${video.r2Key}`);
          await R2Storage.deleteFile(video.r2Key);
          console.log(`✅ Deleted from R2: ${video.r2Key}`);
        } catch (r2Error) {
          console.error(`⚠️ Failed to delete from R2 (continuing with DB deletion):`, r2Error);
          // Continue with database deletion even if R2 deletion fails
        }
      }

      // Delete from database
      const deleted = await storage.deleteVideo(videoId);
      if (!deleted) {
        console.log(`❌ Failed to delete video ${videoId} from database`);
        return res.status(500).json({ error: 'Failed to delete video from database' });
      }

      console.log(`✅ Video ${videoId} deleted successfully`);
      res.json({
        success: true,
        message: 'Video deleted successfully',
        videoId
      });
    } catch (error) {
      console.error('Delete video error:', error);
      res.status(500).json({ error: 'Failed to delete video' });
    }
  });

  app.patch('/api/videos/:id/metadata', requireAuth, async (req, res) => {
    try {
      const videoId = parseInt(req.params.id);
      const { videoTitle, artistInfo } = req.body;

      console.log(`📝 Updating metadata for video ${videoId}:`, { videoTitle, artistInfo });

      // Get the video to verify ownership
      const video = await storage.getVideo(videoId);
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }

      // Verify user owns this video
      if (video.userEmail !== req.user?.email) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Update metadata
      const updated = await storage.updateVideo(videoId, {
        videoTitle: videoTitle || null,
        artistInfo: artistInfo || null
      });

      console.log(`✅ Video ${videoId} metadata updated successfully`);
      res.json({ success: true, video: updated });
    } catch (error) {
      console.error('Failed to update video metadata:', error);
      res.status(500).json({ error: 'Failed to update metadata' });
    }
  });

  // Add direct upload endpoint for small files with full metadata extraction
  app.post('/api/upload', requireAuth, upload.single('video'), async (req, res) => {
    try {
      console.log('📤 Upload request received:', {
        hasFile: !!req.file,
        userEmail: req.user?.email,
        contentType: req.get('content-type'),
        contentLength: req.get('content-length'),
        userAgent: req.get('user-agent')?.substring(0, 50),
        sessionCookie: req.get('cookie')?.includes('cutmv-session') ? 'present' : 'missing'
      });

      if (!req.file) {
        console.error('❌ No file in upload request - possible auth or multer issue');
        return res.status(400).json({ 
          error: 'No video file uploaded',
          debug: {
            hasAuth: !!req.user,
            userEmail: req.user?.email,
            contentType: req.get('content-type'),
            hasSession: req.get('cookie')?.includes('cutmv-session')
          }
        });
      }

      console.log('📤 Direct upload received:', {
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        bufferSize: req.file.buffer?.length
      });

      // Attempt R2 upload for direct uploads too
      let r2Key: string | undefined;
      let r2Url: string | undefined;
      
      try {
        // Ensure complete user folder structure exists before upload
        if (req.user?.email) {
          const clientIP = req.ip || req.connection.remoteAddress || 'Unknown';
          const userAgent = req.get('User-Agent') || 'Unknown';
          await R2Storage.ensureUserFolderStructure(req.user.email, clientIP, userAgent);
        }
        
        r2Key = R2Storage.generateR2Key(req.file.originalname, 'uploads', req.user?.email);
        console.log(`🚀 Direct upload R2 buffer: ${req.file.originalname} -> ${r2Key}`);
        await R2Storage.uploadBuffer(req.file.buffer, r2Key, 'video/mp4', req.user?.email);
        r2Url = await R2Storage.getSignedUrl(r2Key, 3600);
        console.log(`✅ Direct upload R2 success: ${r2Key}`);
        
        // Log upload activity
        if (req.user?.email) {
          await R2Storage.logUserActivity(req.user.email, 'FILE_UPLOADED', {
            filename: req.file.originalname,
            size: req.file.size,
            method: 'direct_upload',
            r2Key: r2Key
          });
        }
      } catch (r2Error) {
        console.error(`❌ Direct upload R2 failed for ${req.file.originalname}:`, r2Error);
        console.error(`Direct upload R2 Error details:`, {
          message: (r2Error as any).message,
          code: (r2Error as any).code,
          stack: (r2Error as any).stack
        });
        return res.status(500).json({ 
          error: `Failed to upload to R2: ${(r2Error as any).message}`,
          details: 'Storage service temporarily unavailable'
        });
      }

      console.log('📝 Direct upload metadata received:', {
        videoTitle: req.body.videoTitle,
        artistInfo: req.body.artistInfo,
        filename: req.file.originalname
      });

      const video = await storage.createVideo({
        filename: req.file.originalname,
        originalName: req.file.originalname,
        path: r2Key!, // R2 key replaces local path
        size: req.file.size,
        videoTitle: req.body.videoTitle || null,
        artistInfo: req.body.artistInfo || null,
        userEmail: req.user?.email || null, // Ensure user email is always set
        r2Key: r2Key,
        r2Url: r2Url,
      });

      console.log('✅ Direct upload: Video created in database:', {
        id: video.id,
        videoTitle: video.videoTitle,
        artistInfo: video.artistInfo,
        originalName: video.originalName
      });

      // Return video immediately - metadata extraction will be done by frontend if needed
      console.log('Returning video:', video);
      res.json({
        id: video.id,
        originalName: video.originalName,  
        filename: video.filename,
        size: video.size,
        duration: video.duration,
        videoTitle: video.videoTitle,
        artistInfo: video.artistInfo,
        uploadedAt: video.uploadedAt,
        processed: video.processed,
        accurateUpload: true,
      });

    } catch (error) {
      console.error('❌ Direct upload error:', error);
      console.error('❌ Direct upload error stack:', (error as Error).stack);
      res.status(500).json({ 
        error: 'Upload failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Processing endpoints
  app.post('/api/process-with-realtime', requireAuth, async (req, res) => {
    try {
      const {
        videoId,
        timestampText,
        generateCutdowns = false,
        generateGif = false,
        generateThumbnails = false,
        generateCanvas = false,
        aspectRatios = ['16:9'],
        quality = 'balanced',
        videoFade = false,
        audioFade = false,
        fadeDuration = 0.5,
        sessionId = crypto.randomUUID(),
      } = req.body;

      if (!videoId) {
        return res.status(400).json({ error: 'Video ID is required' });
      }

      // Get video from storage
      const video = await storage.getVideo(videoId);
      if (!video) {
        return res.status(404).json({ error: 'Video not found' });
      }

      console.log(`🎬 Starting enhanced processing for video ${videoId}`);

      const { backgroundJobManager } = await import('./background-job-manager.js');

      // Check if user already has an active job
      const userEmail = req.user?.email || 'unknown@user.com';
      const hasActiveJob = await backgroundJobManager.hasActiveJob(userEmail);

      if (hasActiveJob) {
        return res.status(409).json({
          success: false,
          message: 'You have reached the maximum of 3 concurrent exports. Please wait for one to complete before starting a new export.',
        });
      }

      // Check if user has enough credits (1 credit per export)
      const userId = req.user!.id;
      const currentCredits = await creditService.getUserCredits(userId);
      const exportCost = 1; // 1 credit per export

      if (currentCredits < exportCost) {
        console.log(`❌ User ${userId} has insufficient credits: ${currentCredits} < ${exportCost}`);
        return res.status(402).json({
          success: false,
          message: 'Insufficient credits. Please purchase credits or subscribe to continue.',
          currentCredits,
          requiredCredits: exportCost
        });
      }
      
      const jobResult = await backgroundJobManager.createJob(
        sessionId,
        videoId,
        userEmail,
        {
          timestampText,
          generateCutdowns,
          generateGif,
          generateThumbnails,
          generateCanvas,
          aspectRatios,
          quality,
          videoFade,
          audioFade,
          fadeDuration,
          originalFilename: video.originalName,
          duration: parseFloat(video.duration || '60')
        }
      );
      
      if (!jobResult.success) {
        return res.status(500).json({
          success: false,
          message: `Failed to create background job: ${jobResult.error}`,
        });
      }

      console.log(`✅ Background job created: ${jobResult.jobId}`);

      // Deduct credits for the export
      const deductionSuccess = await creditService.deductCredits(
        userId,
        exportCost,
        `Export processing for video ${videoId}`
      );

      if (!deductionSuccess) {
        console.error(`❌ Failed to deduct credits for user ${userId} after job creation`);
        // Job was already created, so we don't fail the request
        // but we log this for manual review
      }

      // Get updated credit balance
      const remainingCredits = await creditService.getUserCredits(userId);

      res.json({
        success: true,
        message: 'Processing started via background job manager',
        jobId: jobResult.jobId,
        sessionId,
        creditsUsed: exportCost,
        remainingCredits
      });

    } catch (error) {
      console.error('Processing start error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to start processing',
      });
    }
  });

  // Price calculation endpoint - subscriber-aware pricing
  app.post('/api/calculate-price', requireAuth, async (req, res) => {
    try {
      const {
        timestampText,
        aspectRatios = [],
        generateGif = false,
        generateThumbnails = false,
        generateCanvas = false,
        discountCode = ''
      } = req.body;

      console.log('💰 Price calculation request:', {
        timestampText: timestampText ? `${timestampText.length} chars` : 'none',
        aspectRatios,
        generateGif,
        generateThumbnails,
        generateCanvas,
        discountCode: discountCode ? `${discountCode} (${discountCode.length} chars)` : 'none'
      });

      // Count timestamps
      const timestampCount = timestampText ?
        timestampText.split('\n')
          .filter((line: string) => line.trim() && line.match(/\d+:\d+\s*-\s*\d+:\d+/))
          .length : 0;

      // Use the credit service to calculate costs with subscriber awareness
      const userId = req.user?.id || null;
      const costResult = await creditService.calculateProcessingCost(userId, {
        timestampCount,
        aspectRatios,
        generateGif,
        generateThumbnails,
        generateCanvas
      });

      const { cost: totalAmount, isSubscriber, savings, subscriberCost } = costResult;

      console.log(`💰 Price calculated: ${totalAmount} credits (subscriber: ${isSubscriber}, would save: ${savings})`);

      // Apply discount codes
      let discountApplied = 0;
      let promoValidation = null;

      if (discountCode.trim()) {
        const trimmedCode = discountCode.trim().toUpperCase();
        console.log(`💰 Applying promo code: ${trimmedCode}`);

        switch (trimmedCode) {
          case 'STAFF25':
            discountApplied = totalAmount; // 100% off
            promoValidation = { isValid: true, code: 'STAFF25', message: 'Staff discount applied - 100% off!' };
            break;
          case 'MORE20':
            discountApplied = Math.round(totalAmount * 0.20); // 20% off
            promoValidation = { isValid: true, code: 'MORE20', message: '20% discount applied!' };
            break;
          case 'GET15':
            discountApplied = Math.round(totalAmount * 0.15); // 15% off
            promoValidation = { isValid: true, code: 'GET15', message: '15% discount applied!' };
            break;
          case 'LAUNCH25':
            discountApplied = Math.round(totalAmount * 0.25); // 25% off
            promoValidation = { isValid: true, code: 'LAUNCH25', message: '25% launch discount applied!' };
            break;
          default:
            promoValidation = { isValid: false, code: trimmedCode, message: 'Invalid promo code' };
        }
      }

      const finalAmount = Math.max(0, totalAmount - discountApplied);

      console.log(`💰 Final calculation: ${totalAmount} - ${discountApplied} = ${finalAmount} credits`);

      // Calculate what the subscriber would pay (for upsell messaging)
      const nonSubscriberCost = isSubscriber ? totalAmount * 2 : totalAmount;

      res.json({
        totalAmount: finalAmount,
        discountApplied,
        promoValidation,
        originalAmount: totalAmount,

        // Subscriber-aware info
        isSubscriber,
        subscriberCost,  // What a subscriber would pay
        nonSubscriberCost: isSubscriber ? nonSubscriberCost : totalAmount,  // What a non-subscriber would pay
        potentialSavings: isSubscriber ? 0 : subscriberCost,  // How much they'd save by subscribing

        breakdown: {
          cutdowns: timestampCount > 0 && aspectRatios.length > 0
            ? timestampCount * aspectRatios.length * (isSubscriber ? 50 : 100)
            : 0,
          exports: totalAmount - (timestampCount > 0 && aspectRatios.length > 0
            ? timestampCount * aspectRatios.length * (isSubscriber ? 50 : 100)
            : 0)
        }
      });

    } catch (error) {
      console.error('Price calculation error:', error);
      res.status(500).json({ error: 'Price calculation failed' });
    }
  });

  // Payment processing
  if (stripe) {
    app.post('/api/create-payment-session', requireAuth, async (req, res) => {
      try {
        const validatedBody = paymentRequestSchema.parse(req.body);
        const { 
          videoId, 
          timestampText, 
          aspectRatios,
          discountCode: promoCode 
        } = validatedBody;

        // Get user's credit balance
        const userCredits = await creditService.getUserCredits(req.user!.id);

        // Validate promo code if provided
        let discount = 0;
        if (promoCode) {
          const promoValidation = await promoCodeService.validatePromoCode(promoCode, req.user!.email, videoId || 0);
          if (promoValidation.isValid) {
            discount = promoValidation.discount || 0;
          }
        }

        // Calculate pricing based on selections using the same logic as pricing endpoint
        let totalAmount = 0;
        const timestampCount = timestampText.split('\n').filter(line => line.trim()).length;
        const aspectRatioCount = aspectRatios.length;
        
        // Cutdowns pricing
        if (timestampCount > 0 && aspectRatioCount > 0) {
          totalAmount += timestampCount * aspectRatioCount * 99; // $0.99 per cutdown
        }
        
        // Export options pricing (from validated body)
        if (validatedBody.useFullPack && (validatedBody.generateGif || validatedBody.generateThumbnails || validatedBody.generateCanvas)) {
          totalAmount += 499; // $4.99 full pack
        } else {
          if (validatedBody.generateGif) totalAmount += 199; // $1.99
          if (validatedBody.generateThumbnails) totalAmount += 199; // $1.99  
          if (validatedBody.generateCanvas) totalAmount += 499; // $4.99
        }

        // Apply promo code discount (simplified logic)
        if (promoCode && promoCode.toUpperCase() === 'STAFF25') {
          discount = 100; // 100% off
          totalAmount = 0;
        } else if (discount > 0) {
          totalAmount = Math.round(totalAmount * (1 - discount / 100));
        }

        if (!videoId) {
          return res.status(400).json({ error: 'Video ID is required' });
        }

        // Get video to verify it exists
        const video = await storage.getVideo(videoId);
        if (!video) {
          return res.status(404).json({ error: 'Video not found' });
        }

        // NEW CREDIT SYSTEM: Process with credits (1 credit = 1 cent worth of features)
        // totalAmount is already in "cents" which equals credits (99 cents = 99 credits)
        const creditsRequired = totalAmount;
        const hasEnoughCredits = userCredits >= creditsRequired;

        console.log(`💳 Credit-based processing for user ${req.user!.email}: has ${userCredits} credits, needs ${creditsRequired} credits`);

        // Process with credits if user has enough (or free with STAFF25 promo)
        if (hasEnoughCredits || promoCode?.toUpperCase() === 'STAFF25') {
          const freeReason = promoCode?.toUpperCase() === 'STAFF25' ? `${promoCode} promo code` : `${creditsRequired} credits`;
          console.log(`🎫 Processing with ${freeReason} for user:`, req.user!.email);
          
          // Generate session ID for free processing
          const sessionId = crypto.randomUUID();

          try {
            // Deduct credits (not for STAFF25 promo which is 100% free)
            if (creditsRequired > 0 && promoCode?.toUpperCase() !== 'STAFF25') {
              const creditsDeducted = await creditService.deductCredits(
                req.user!.id,
                creditsRequired,
                `Video processing - ${timestampCount} clips (Video ID: ${videoId})`
              );

              if (!creditsDeducted) {
                return res.status(400).json({
                  error: 'Insufficient credits',
                  required: creditsRequired,
                  available: userCredits
                });
              }

              console.log(`✅ Deducted ${creditsRequired} credits from user ${req.user!.email}`);
            }

            // Start processing directly without payment
            const processingOptions = {
              generateCutdowns: aspectRatios.length > 0,
              generateGif: validatedBody.generateGif || false,
              generateThumbnails: validatedBody.generateThumbnails || false,
              generateCanvas: validatedBody.generateCanvas || false,
              aspectRatios,
              quality: 'high',
              videoFade: validatedBody.videoFade || false,
              audioFade: validatedBody.audioFade || false,
              fadeDuration: validatedBody.fadeDuration || 0.5,
              sessionId,
              freeProcessing: true,
              userEmail: req.user!.email
            };

            // Start video processing immediately using background job manager
            console.log('🎬 Starting free video processing with background job manager');
            const jobResult = await backgroundJobManager.createJob(sessionId, videoId, req.user!.email, {
              ...processingOptions,
              timestampText
            });

            if (!jobResult.success) {
              console.error('❌ Failed to create background job:', jobResult.error);
              return res.status(500).json({ error: 'Failed to start processing' });
            }

            return res.json({
              success: true,
              creditBased: true,
              sessionId,
              creditsUsed: creditsRequired,
              message: promoCode?.toUpperCase() === 'STAFF25' ? `Free processing started with ${promoCode}!` : `Processing started using ${creditsRequired} credits`
            });

          } catch (processingError) {
            console.error('Credit-based processing error:', processingError);
            return res.status(500).json({ error: 'Failed to start processing' });
          }
        }

        // User doesn't have enough credits - return error asking them to purchase more
        console.log(`❌ Insufficient credits: user has ${userCredits}, needs ${creditsRequired}`);
        return res.status(402).json({
          error: 'Insufficient credits',
          required: creditsRequired,
          available: userCredits,
          shortfall: creditsRequired - userCredits,
          message: `You need ${creditsRequired} credits but only have ${userCredits}. Please purchase ${creditsRequired - userCredits} more credits to continue.`
        });
      } catch (error) {
        console.error('Payment session creation error:', error);
        res.status(500).json({ error: 'Failed to create payment session' });
      }
    });
  }

  // Progress tracking endpoints
  app.get('/api/processing-status/:videoId', requireAuth, (req, res) => {
    const videoId = parseInt(req.params.videoId);
    const job = enhancedProcessor.getJobStatus(videoId);
    
    if (job) {
      res.json({
        status: job.status,
        progress: Math.round((job.completedOperations / job.totalOperations) * 100),
        currentOperation: job.currentOperation,
        downloadPath: job.downloadPath,
        r2DownloadUrl: job.r2DownloadUrl,
        errors: job.errors,
      });
    } else {
      res.json({ status: 'not_found' });
    }
  });

  // Legacy download endpoint - now redirects to R2-only secure downloads
  app.get('/api/download/:filename', requireAuth, async (req, res) => {
    try {
      const filename = req.params.filename;
      const userEmail = req.user?.email;
      
      if (!userEmail) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Find the background job by filename and user
      const jobs = await storage.getUserBackgroundJobs(userEmail);
      const job = jobs.find((j: any) => j.downloadPath?.includes(filename));
      
      if (!job) {
        return res.status(404).json({ error: 'Export not found' });
      }

      // Generate secure download token and redirect
      const { downloadTokenManager } = await import('./download-tokens.js');
      const token = await downloadTokenManager.generateToken(job.sessionId, filename, userEmail, 24);
      
      console.log(`📥 Legacy download redirected to secure: ${filename} by ${userEmail}`);
      res.redirect(`/api/secure-download/${token}`);
    } catch (error) {
      console.error('Download endpoint error:', error);
      res.status(500).json({ error: 'Download failed' });
    }
  });

  // Debug endpoint for token validation
  app.post('/api/debug-token', async (req, res) => {
    try {
      const { token } = req.body;
      const { downloadTokenManager } = await import('./download-tokens.js');
      const tokenData = await downloadTokenManager.validateToken(token);
      console.log(`🔍 Debug token validation for: ${token} -> ${JSON.stringify(tokenData)}`);
      res.json({ valid: !!tokenData, tokenData });
    } catch (error) {
      console.error('Token debug error:', error);
      res.status(500).json({ error: 'Debug failed' });
    }
  });

  // Bulk ZIP download endpoint - Pro+ subscribers only
  app.get('/api/bulk-download/:sessionId', requireAuth, async (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const userId = req.user?.id;
      const userEmail = req.user?.email;

      if (!userId || !userEmail) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Check if user has Pro+ subscription with bulk download access
      const canBulkDownload = await subscriptionService.canBulkDownload(userId);
      if (!canBulkDownload) {
        return res.status(403).json({
          error: 'Bulk download is a Pro+ feature',
          message: 'Upgrade to Pro or Enterprise to download all exports as a single ZIP file'
        });
      }

      console.log(`📦 Bulk download requested for session: ${sessionId} by ${userEmail}`);

      // Get the background job
      const job = await storage.getBackgroundJob(sessionId);
      if (!job) {
        return res.status(404).json({ error: 'Export session not found' });
      }

      // Verify user owns this job
      if (job.userEmail !== userEmail) {
        return res.status(404).json({ error: 'Export session not found' });
      }

      // Check job is completed
      if (job.status !== 'completed') {
        return res.status(400).json({ error: 'Export is still processing' });
      }

      // Check job has a download path
      if (!job.downloadPath) {
        return res.status(404).json({ error: 'No exports available for this session' });
      }

      console.log(`📦 Fetching exports from R2: ${job.downloadPath}`);

      // Get the export ZIP from R2
      const { R2Storage } = await import('./r2-storage.js');
      const r2Key = job.downloadPath.startsWith('/api/download/')
        ? job.downloadPath.replace('/api/download/', '')
        : job.downloadPath;

      const zipBuffer = await R2Storage.downloadFile(r2Key);

      if (!zipBuffer || zipBuffer.length === 0) {
        return res.status(404).json({ error: 'Export files not found in storage' });
      }

      // Generate ZIP filename from associated video
      let zipFilename = 'cutmv_exports.zip';
      if (job.videoId) {
        const video = await storage.getVideo(job.videoId);
        if (video) {
          const videoName = (video.videoTitle || video.originalName)?.replace(/\.[^/.]+$/, '') || 'exports';
          zipFilename = `${videoName}_cutmv_exports.zip`;
        }
      }

      // Send ZIP file
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
      res.setHeader('Content-Length', zipBuffer.length);
      res.send(zipBuffer);

      console.log(`📦 Bulk download complete: ${zipFilename} (${zipBuffer.length} bytes)`);
    } catch (error) {
      console.error('Bulk download error:', error);
      res.status(500).json({ error: 'Bulk download failed' });
    }
  });

  // Check if user can bulk download (for frontend to show/hide button)
  app.get('/api/can-bulk-download', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.json({ canBulkDownload: false });
      }

      const canBulkDownload = await subscriptionService.canBulkDownload(userId);
      res.json({ canBulkDownload });
    } catch (error) {
      console.error('Can bulk download check error:', error);
      res.json({ canBulkDownload: false });
    }
  });

  // Billing: Get user's saved payment methods
  app.get('/api/billing/payment-methods', requireAuth, async (req, res) => {
    try {
      if (!stripe) {
        return res.json({ paymentMethods: [] });
      }

      const user = req.user;
      if (!user?.stripeCustomerId) {
        return res.json({ paymentMethods: [] });
      }

      const paymentMethods = await stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card',
      });

      const formattedMethods = paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card?.brand || 'unknown',
        last4: pm.card?.last4 || '****',
        expMonth: pm.card?.exp_month || 0,
        expYear: pm.card?.exp_year || 0,
      }));

      res.json({ paymentMethods: formattedMethods });
    } catch (error) {
      console.error('Error fetching payment methods:', error);
      res.status(500).json({ error: 'Failed to fetch payment methods' });
    }
  });

  // Billing: Create Setup Intent for adding a payment method
  app.post('/api/billing/setup-intent', requireAuth, async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: 'Payment processing is not configured' });
      }

      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get or create Stripe customer
      let customerId = user.stripeCustomerId;

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: user.id },
        });
        customerId = customer.id;

        // Save the customer ID to the user
        await authService.updateUser(user.id, { stripeCustomerId: customerId });
      }

      // Create a Setup Intent
      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
        metadata: { userId: user.id },
      });

      console.log(`✅ Created setup intent for user ${user.email}: ${setupIntent.id}`);

      res.json({ clientSecret: setupIntent.client_secret });
    } catch (error) {
      console.error('Setup intent error:', error);
      res.status(500).json({ error: 'Failed to create setup intent' });
    }
  });

  // Secure download endpoint with tokens - redirects to R2 URLs  
  app.get('/api/secure-download/:token', async (req, res) => {
    try {
      const token = req.params.token;
      console.log(`🔍 Processing secure download for token: ${token}`);
      
      // Validate and decode the download token
      const { downloadTokenManager } = await import('./download-tokens.js');
      const tokenData = await downloadTokenManager.validateToken(token);
      
      console.log(`🔍 Token validation result: ${JSON.stringify(tokenData)}`);
      
      if (!tokenData) {
        console.error(`❌ Invalid or expired download token: ${token}`);
        return res.status(404).json({ error: 'Download link invalid or expired' });
      }
      
      console.log(`✅ Valid token for session: ${tokenData.sessionId} (user: ${tokenData.userEmail})`);

      // Look up the background job to get the R2 download URL
      const backgroundJob = await storage.getBackgroundJob(tokenData.sessionId);
      
      if (!backgroundJob) {
        console.error(`❌ Background job not found for session: ${tokenData.sessionId}`);
        return res.status(404).json({ error: 'Export not found' });
      }
      
      // Verify user owns this export
      if (backgroundJob.userEmail !== tokenData.userEmail) {
        console.error(`❌ User mismatch: token user=${tokenData.userEmail}, job user=${backgroundJob.userEmail}`);
        return res.status(404).json({ error: 'Export not found' });
      }

      // Always generate fresh R2 URLs since they expire after 1 hour
      // Skip the cached URL check - generate fresh every time

      // Always generate fresh R2 signed URLs since they expire after 1 hour
      if (backgroundJob.downloadPath) {
        let r2Key = backgroundJob.downloadPath;
        
        // Fix R2 key format - remove /api/download/ prefix if present
        if (r2Key && r2Key.startsWith('/api/download/')) {
          r2Key = 'exports/' + r2Key.replace('/api/download/', '');
          console.log(`🔧 Fixed R2 key format: ${r2Key}`);
        }
        
        try {
          console.log(`🔍 Processing download for R2 key: ${r2Key}`);
          
          const { R2Storage } = await import('./r2-storage.js');
          
          // Validate user has access to this R2 object
          const hasAccess = await R2Storage.validateUserAccess(r2Key, tokenData.userEmail);
          if (!hasAccess) {
            console.error(`🚫 Access denied: User ${tokenData.userEmail} cannot access ${r2Key}`);
            return res.status(403).json({ error: 'Access denied to this export' });
          }

          // WORKAROUND: R2 signed URLs are returning 403
          // Use direct download via SDK instead of redirecting to signed URL
          console.log(`📥 Downloading file directly from R2 (signed URL workaround): ${r2Key}`);

          const fileBuffer = await R2Storage.downloadFile(r2Key);
          const rawFilename = r2Key.split('/').pop() || 'download.zip';

          // Strip timestamp and random ID prefix for clean user-facing download filename
          // R2 storage keeps prefix for tracking, but user downloads are clean
          const cleanFilename = rawFilename.replace(/^\d+-[a-z0-9]+-/, '');

          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
          res.setHeader('Content-Length', fileBuffer.length);

          console.log(`✅ Serving ${fileBuffer.length} bytes directly for: ${r2Key} to ${tokenData.userEmail}`);
          return res.send(fileBuffer);
        } catch (r2Error: any) {
          const errorCode = r2Error.name || r2Error.code || 'UnknownError';
          console.error(`❌ R2 signed URL generation failed for ${r2Key}:`, {
            errorCode,
            message: r2Error.message,
            r2Key, 
            userEmail: tokenData.userEmail,
            sessionId: tokenData.sessionId,
            backgroundJobId: backgroundJob.sessionId
          });
          
          // Return specific error based on R2 error type
          if (errorCode === 'NoSuchKey' || r2Error.message?.includes('NoSuchKey')) {
            return res.status(404).json({ 
              error: 'Export file no longer exists in storage',
              details: 'The file may have expired or been removed'
            });
          } else if (errorCode === 'ExpiredRequest' || r2Error.message?.includes('expired')) {
            return res.status(403).json({ 
              error: 'Download request expired',
              details: 'Please try downloading again from your dashboard'
            });
          } else {
            return res.status(500).json({ 
              error: 'Download temporarily unavailable',
              details: 'Please try again in a moment'
            });
          }
        }
      }

      // NO LOCAL FILES - R2 only
      console.error(`❌ R2 file not accessible for download`);

      console.error(`❌ Download failed - comprehensive diagnostics:`, { 
        sessionId: tokenData.sessionId,
        downloadPath: backgroundJob.downloadPath,
        userEmail: tokenData.userEmail,
        validationFilename: 'direct-sessionid-access',
        backgroundJobExists: !!backgroundJob,
        backgroundJobStatus: backgroundJob?.status,
        r2DownloadUrlExists: !!backgroundJob?.r2DownloadUrl,
        tokenValid: true
      });
      return res.status(404).json({ error: 'File not found' });
    } catch (error) {
      console.error('Secure download endpoint error:', error);
      res.status(500).json({ error: 'Download failed' });
    }
  });



  // Time estimation endpoint for processing options
  app.post('/api/estimate-processing-time', requireAuth, async (req, res) => {
    try {
      const { processingOptions, videoData } = req.body;
      
      if (!processingOptions || !videoData) {
        return res.status(400).json({ error: 'Processing options and video data required' });
      }

      // Calculate comprehensive processing complexity and time estimation
      const complexity = TimeEstimationService.calculateProcessingComplexity(processingOptions, videoData);
      const timeEstimate = TimeEstimationService.estimateProcessingTime(complexity);

      console.log(`📊 Time estimation requested for user ${req.user?.email}:`, {
        totalEstimate: timeEstimate.totalEstimatedDisplay,
        exportTypes: timeEstimate.exportEstimates.length,
        bulkProcessing: timeEstimate.bulkProcessingDetected,
        fileSize: complexity.fileSizeGB + 'GB',
        operationCount: complexity.operationCount
      });

      res.json({
        success: true,
        timeEstimate: {
          totalEstimatedSeconds: timeEstimate.totalEstimatedSeconds,
          totalEstimatedDisplay: timeEstimate.totalEstimatedDisplay,
          bulkProcessingDetected: timeEstimate.bulkProcessingDetected,
          warningMessages: timeEstimate.warningMessages,
          exportBreakdown: timeEstimate.exportEstimates.map(est => ({
            type: est.type,
            estimatedTimeDisplay: est.estimatedTimeDisplay,
            estimatedTimeSeconds: est.estimatedTimeSeconds,
            bulkMultiplier: est.bulkMultiplier,
            qualityMultiplier: est.qualityMultiplier
          })),
          complexity: {
            operationCount: complexity.operationCount,
            exportTypes: complexity.exportTypes,
            fileSizeGB: complexity.fileSizeGB,
            videoDurationMinutes: complexity.videoDurationMinutes,
            isBulkProcessing: complexity.isBulkProcessing,
            isMaxComplexity: complexity.isMaxComplexity,
            breakdown: complexity.breakdown
          }
        }
      });

    } catch (error) {
      console.error('Time estimation error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to calculate time estimate' 
      });
    }
  });

  // Manual failure notification endpoint (for immediate user alerts)
  app.post('/api/send-failure-notification', async (req, res) => {
    try {
      const { sessionId, userEmail, videoName, errorMessage } = req.body;
      
      if (!sessionId || !userEmail) {
        return res.status(400).json({ error: 'Session ID and user email required' });
      }

      console.log(`📧 Sending manual failure notification to ${userEmail} for session ${sessionId}`);

      // Import email service
      const { integratedEmailWorkflow } = await import('./integrated-email-workflow.js');
      
      const emailResult = await integratedEmailWorkflow.sendEmail({
        userEmail,
        emailType: 'processing_started', // Use processing template for failures
        sessionId,
        videoName: videoName || 'Your video',
        professionalQuality: true,
        skipVerification: false
      });
      
      if (emailResult.success) {
        console.log(`✅ Manual failure notification sent: ${emailResult.messageId}`);
        res.json({
          success: true,
          messageId: emailResult.messageId,
          message: 'Failure notification sent successfully'
        });
      } else {
        console.error(`❌ Failed to send manual notification: ${emailResult.error}`);
        res.status(500).json({
          success: false,
          error: emailResult.error,
          message: 'Failed to send notification'
        });
      }
      
    } catch (error) {
      console.error('Manual notification endpoint error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Session status endpoint for thank-you page
  app.get('/api/session-status/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;

      // Look up background job by session ID
      const job = await storage.getBackgroundJob(sessionId);

      if (job) {
        res.json({
          sessionId,
          videoId: job.videoId,
          status: job.status,
          progress: job.progress
        });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    } catch (error) {
      console.error('Error fetching session status:', error);
      res.status(500).json({ error: 'Failed to fetch session status' });
    }
  });

  // Job status endpoint with download URL - for auto-refresh on thank-you page
  app.get('/api/job-status/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;

      // Look up background job by session ID
      const job = await storage.getBackgroundJob(sessionId);

      if (job) {
        // Generate download URL if job is completed
        let downloadUrl = null;
        if (job.status === 'completed' && job.downloadPath) {
          try {
            const { downloadTokenManager } = await import('./download-tokens.js');
            const filename = job.downloadPath.startsWith('/api/download/')
              ? job.downloadPath.replace('/api/download/', '')
              : job.downloadPath;

            // Generate secure download token (24 hour expiration)
            const token = await downloadTokenManager.generateToken(
              sessionId,
              filename,
              job.userEmail || '',
              24
            );
            downloadUrl = `/api/secure-download/${token}`;
          } catch (error) {
            console.error('Failed to generate download URL:', error);
          }
        }

        res.json({
          sessionId,
          videoId: job.videoId,
          status: job.status,
          progress: job.progress,
          downloadUrl,
          completedAt: job.completedAt,
          errorMessage: job.errorMessage
        });
      } else {
        res.status(404).json({ error: 'Job not found' });
      }
    } catch (error) {
      console.error('Error fetching job status:', error);
      res.status(500).json({ error: 'Failed to fetch job status' });
    }
  });

  // R2 diagnostics endpoint for troubleshooting downloads (authenticated)
  app.get('/api/r2-diagnostics/:sessionId', requireAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userEmail = req.user?.email;
      
      if (!userEmail) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get background job
      const job = await storage.getBackgroundJob(sessionId);
      if (!job || job.userEmail !== userEmail) {
        return res.status(404).json({ error: 'Export session not found' });
      }

      const diagnostics: any = {
        sessionId,
        userEmail,
        jobStatus: job.status,
        downloadPath: job.downloadPath,
        hasR2DownloadUrl: !!job.r2DownloadUrl,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      };

      // Test R2 access if downloadPath exists
      if (job.downloadPath) {
        try {
          const { R2Storage } = await import('./r2-storage.js');
          
          // Check if user has access
          const hasAccess = await R2Storage.validateUserAccess(job.downloadPath, userEmail);
          diagnostics.r2Access = hasAccess ? 'GRANTED' : 'DENIED';
          
          if (hasAccess) {
            // Try to generate a fresh signed URL
            const signedUrl = await R2Storage.getSignedUrl(job.downloadPath, 300); // 5 minute test URL
            diagnostics.r2SignedUrlTest = 'SUCCESS';
            diagnostics.testUrl = signedUrl.substring(0, 100) + '...';
          }
        } catch (r2Error: any) {
          diagnostics.r2Error = {
            code: r2Error.name || r2Error.code || 'UnknownError',
            message: r2Error.message
          };
        }
      }

      res.json({
        success: true,
        diagnostics
      });

    } catch (error) {
      console.error('R2 diagnostics error:', error);
      res.status(500).json({ error: 'Diagnostics failed' });
    }
  });



  // Additional helper endpoints
  app.post('/api/parse-timestamps', requireAuth, async (req, res) => {
    try {
      const { text, videoId } = req.body;
      
      // Basic timestamp parsing logic
      const lines = text.split('\n').filter((line: string) => line.trim());
      const timestamps = [];
      const errors = [];
      const warnings: string[] = [];

      for (const line of lines) {
        const match = line.match(/(\d+:\d+)\s*-\s*(\d+:\d+)/);
        if (match) {
          timestamps.push({
            startTime: match[1],
            endTime: match[2],
          });
        } else if (line.trim()) {
          errors.push(`Invalid timestamp format: ${line}`);
        }
      }

      res.json({ timestamps, errors, warnings });
    } catch (error) {
      console.error('Timestamp parsing error:', error);
      res.status(500).json({ error: 'Timestamp parsing failed' });
    }
  });

  // Remove duplicate upload endpoint - handled by the main one above

  // Stripe webhook endpoint for processing after payment
  app.post('/api/webhooks/stripe', express.raw({type: 'application/json'}), async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    let event;
    try {
      const sig = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      
      if (webhookSecret) {
        event = stripe.webhooks.constructEvent(req.body, sig as string, webhookSecret);
      } else {
        // For development without webhook secret
        event = JSON.parse(req.body.toString());
      }
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      return res.status(400).send('Webhook Error');
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const { videoId, userId, processingOptions, timestampText, creditsApplied, creditDiscount } = session.metadata;

      try {
        const options = JSON.parse(processingOptions);

        // Deduct credits if they were applied to this payment
        if (creditsApplied && parseInt(creditsApplied) > 0) {
          const creditsUsed = parseInt(creditsApplied);
          const deducted = await creditService.deductCredits(
            userId,
            creditsUsed,
            `Video processing payment (Session: ${session.id.substring(0, 8)}...)`
          );

          if (deducted) {
            console.log(`💳 Deducted ${creditsUsed} credits from user ${userId} for payment`);
          } else {
            console.error(`❌ Failed to deduct ${creditsUsed} credits from user ${userId}`);
          }
        }

        // Get video from storage
        const video = await storage.getVideo(parseInt(videoId));
        if (!video) {
          throw new Error(`Video ${videoId} not found`);
        }

        console.log(`📼 Loaded video ${videoId} metadata from database:`, {
          videoTitle: video.videoTitle,
          artistInfo: video.artistInfo,
          originalName: video.originalName
        });
        console.log(`💳 Payment completed for video ${videoId}, starting processing...`);
        
        // Start processing
        await enhancedProcessor.startProcessing(parseInt(videoId), video, {
          timestampText,
          sessionId: session.id,
          ...options
        });
        
      } catch (error) {
        console.error('Webhook processing error:', error);
      }
    }

    res.json({ received: true });
  });

  app.post('/api/verify-email', verifyEmailEndpoint);

  // Feedback submission endpoint
  app.post('/api/feedback', async (req, res) => {
    try {
      const { feedback, category, rating, userEmail, page, timestamp } = req.body;
      
      if (!feedback?.trim() || !category) {
        return res.status(400).json({ error: 'Feedback and category are required' });
      }

      // Log feedback to console for immediate visibility
      console.log('📝 User Feedback Received:', {
        feedback: feedback.trim(),
        category,
        rating,
        userEmail: userEmail || 'anonymous',
        page,
        timestamp
      });

      // Store feedback in simple format
      const feedbackEntry = {
        id: crypto.randomUUID(),
        feedback: feedback.trim(),
        category,
        rating,
        userEmail: userEmail || 'anonymous',
        page,
        timestamp: timestamp || new Date().toISOString(),
        processed: false
      };

      // Send feedback email to staff
      try {
        const ratingStars = rating ? '⭐'.repeat(rating) : 'Not rated';
        const emailSubject = `CUTMV Feedback: ${category}`;
        const emailText = `
New feedback received for CUTMV:

Category: ${category}
Rating: ${ratingStars}
Page: ${page}
User: ${userEmail || 'anonymous'}
Timestamp: ${timestamp || new Date().toISOString()}

Feedback:
${feedback.trim()}

---
Feedback ID: ${feedbackEntry.id}
        `.trim();

        const emailHtml = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CUTMV Feedback - ${category}</title>
  </head>
  <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
      <!-- Header -->
      <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 2px solid #8cc63f;">
        <div style="display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 8px;">
          <img src="https://cutmv.fulldigitalll.com/fd-logo.png" alt="Full Digital" style="width: 28px; height: 28px;" />
          <h1 style="margin: 0; color: #8cc63f; font-size: 28px; font-weight: 700;">CUTMV Feedback</h1>
        </div>
        <p style="margin: 0; color: #666; font-size: 14px;">User Feedback Submission</p>
      </div>

      <!-- Feedback Details -->
      <div style="background: #f8fafc; padding: 30px; border-radius: 12px; margin-bottom: 30px;">
        <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 20px;">Feedback Details</h2>
        
        <div style="margin-bottom: 15px;">
          <strong style="color: #374151;">Category:</strong> <span style="background: #8cc63f; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">${category}</span>
        </div>
        
        <div style="margin-bottom: 15px;">
          <strong style="color: #374151;">Rating:</strong> ${ratingStars}
        </div>
        
        <div style="margin-bottom: 15px;">
          <strong style="color: #374151;">Page:</strong> ${page}
        </div>
        
        <div style="margin-bottom: 15px;">
          <strong style="color: #374151;">User:</strong> ${userEmail || 'anonymous'}
        </div>
        
        <div style="margin-bottom: 20px;">
          <strong style="color: #374151;">Submitted:</strong> ${timestamp || new Date().toISOString()}
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #8cc63f;">
          <strong style="color: #374151; display: block; margin-bottom: 10px;">Feedback:</strong>
          <p style="margin: 0; color: #4b5563; white-space: pre-wrap;">${feedback.trim()}</p>
        </div>
      </div>

      <!-- Footer -->
      <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; color: #9ca3af; font-size: 12px;">
          Feedback ID: ${feedbackEntry.id}<br>
          Generated by CUTMV Feedback System
        </p>
      </div>
    </div>
  </body>
</html>
        `;

        await emailService.sendEmail({
          to: 'staff@fulldigitalll.com',
          subject: emailSubject,
          text: emailText,
          html: emailHtml
        });

        console.log('✅ Feedback email sent to staff@fulldigitalll.com');
        
      } catch (emailError) {
        console.error('❌ Failed to send feedback email:', emailError);
        // Don't fail the request if email fails - still log the feedback
      }

      console.log('💡 CUTMV Feedback:', JSON.stringify(feedbackEntry, null, 2));

      res.json({ 
        success: true, 
        message: 'Feedback received successfully',
        id: feedbackEntry.id
      });

    } catch (error) {
      console.error('Feedback submission error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  });

  // AI Metadata suggestion endpoint
  app.post('/api/suggest-metadata', requireAuth, async (req, res) => {
    try {
      const { originalName, filename, size, duration } = req.body;
      const actualFilename = originalName || filename;
      
      console.log(`🔍 AI metadata request received:`, {
        originalName,
        filename,
        actualFilename,
        hasAI: aiMetadataService.isAvailable()
      });
      
      if (!actualFilename) {
        return res.status(400).json({ error: 'Filename is required' });
      }

      // Create video file info for AI service
      const fileInfo = {
        originalName: actualFilename,
        size: size || 0,
        duration: duration || null,
        format: actualFilename.split('.').pop() || 'unknown'
      };

      // Get AI suggestions
      const suggestion = await aiMetadataService.suggestMetadata(fileInfo);
      
      if (suggestion) {
        console.log(`✅ AI suggestion successful for "${actualFilename}"`);
        res.json({
          success: true,
          suggestion,
          source: 'ai'
        });
      } else {
        console.log(`ℹ️ No AI suggestions generated for "${actualFilename}"`);
        res.json({
          success: false,
          message: 'No suggestions generated'
        });
      }

    } catch (error) {
      console.error('❌ Metadata suggestion error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate suggestions'
      });
    }
  });

  // User dashboard routes (import from user-routes)
  try {
    const userRouter = (await import('./user-routes.js')).default;
    app.use('/api/user', userRouter);
    console.log('✅ User dashboard routes registered');
  } catch (error) {
    console.error('❌ Failed to register user routes:', error);
  }

  // Dashboard diagnostics endpoint for troubleshooting uploads not showing
  app.get('/api/dashboard-debug', requireAuth, async (req, res) => {
    try {
      const userEmail = req.user?.email;
      if (!userEmail) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get comprehensive dashboard data for debugging
      const userVideos = await storage.getUserVideos(userEmail);
      const userJobs = await storage.getUserBackgroundJobs(userEmail);
      const { R2Storage } = await import('./r2-storage.js');
      
      // Check which videos have R2 keys (new structure)
      const videosWithR2 = [];
      const videosWithoutR2 = [];
      
      for (const video of userVideos) {
        if (video.r2Key) {
          try {
            await R2Storage.getSignedUrl(video.r2Key, 60);
            videosWithR2.push(video);
          } catch {
            // R2 key exists but file is gone
            videosWithR2.push({ ...video, r2Status: 'file_missing' });
          }
        } else {
          videosWithoutR2.push(video);
        }
      }
      
      // Check which jobs have per-user R2 paths
      const jobsWithPerUserR2 = userJobs.filter(j => j.downloadPath && j.downloadPath.startsWith('user-'));
      const jobsWithoutPerUserR2 = userJobs.filter(j => !j.downloadPath || !j.downloadPath.startsWith('user-'));
      
      const debugInfo = {
        userEmail,
        timestamp: new Date().toISOString(),
        summary: {
          totalVideos: userVideos.length,
          videosWithR2Keys: videosWithR2.length,
          videosWithoutR2Keys: videosWithoutR2.length,
          totalJobs: userJobs.length,
          jobsWithPerUserR2: jobsWithPerUserR2.length,
          jobsWithoutPerUserR2: jobsWithoutPerUserR2.length
        },
        videosWithR2: videosWithR2.map(v => ({
          id: v.id,
          originalName: v.originalName,
          r2Key: v.r2Key,
          r2Status: (v as any).r2Status || 'exists'
        })),
        videosWithoutR2: videosWithoutR2.map(v => ({
          id: v.id,
          originalName: v.originalName,
          filename: v.filename
        })),
        jobsWithPerUserR2: jobsWithPerUserR2.map(j => ({
          id: j.id,
          sessionId: j.sessionId,
          status: j.status,
          downloadPath: j.downloadPath
        })),
        jobsWithoutPerUserR2: jobsWithoutPerUserR2.map(j => ({
          id: j.id,
          sessionId: j.sessionId,
          status: j.status,
          downloadPath: j.downloadPath
        }))
      };

      console.log(`🔍 Dashboard debug for ${userEmail}:`, debugInfo.summary);
      res.json(debugInfo);
    } catch (error) {
      console.error('Dashboard debug error:', error);
      res.status(500).json({ error: 'Debug failed' });
    }
  });

  // URL Security API endpoints
  app.post('/api/decrypt-session', (req, res) => {
    try {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ success: false, error: 'Token required' });
      }
      
      const sessionData = urlSecurity.decodeSessionToken(token);
      res.json({
        success: true,
        email: sessionData.email,
        sessionId: sessionData.sessionId,
        videoName: sessionData.videoName
      });
    } catch (error) {
      console.error('Session decryption failed:', error);
      res.status(400).json({ success: false, error: 'Invalid session token' });
    }
  });

  // Generate encrypted reuse token
  app.post('/api/generate-reuse-token', requireAuth, (req, res) => {
    try {
      const { videoId } = req.body;
      const userEmail = req.user?.email;
      
      if (!videoId || !userEmail) {
        return res.status(400).json({ success: false, error: 'Video ID and authentication required' });
      }
      
      const token = urlSecurity.generateVideoReuseToken(videoId, userEmail);
      res.json({ success: true, token });
    } catch (error) {
      console.error('Reuse token generation failed:', error);
      res.status(500).json({ success: false, error: 'Failed to generate reuse token' });
    }
  });

  app.post('/api/decrypt-reuse-token', requireAuth, (req, res) => {
    try {
      const { token } = req.body;
      const userEmail = req.user?.email;
      
      if (!token || !userEmail) {
        return res.status(400).json({ success: false, error: 'Token and authentication required' });
      }
      
      const reuseData = urlSecurity.decodeVideoReuseToken(token);
      
      // Verify the token belongs to the authenticated user
      if (reuseData.userEmail !== userEmail) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
      }
      
      res.json({
        success: true,
        videoId: reuseData.videoId
      });
    } catch (error) {
      console.error('Reuse token decryption failed:', error);
      res.status(400).json({ success: false, error: 'Invalid or expired reuse token' });
    }
  });

  // Authentication routes (import from auth-routes)
  try {
    const authRouter = (await import('./auth-routes.js')).default;
    app.use('/api/auth', authRouter);
    console.log('✅ Authentication routes registered');
  } catch (error) {
    console.error('❌ Failed to register auth routes:', error);
  }

  // Manual job management endpoint for debugging stuck jobs
  app.post('/api/manual-trigger', async (req, res) => {
    try {
      const { action, sessionId, videoId } = req.body;
      
      if (action === 'start_job' && sessionId) {
        // Get the background job
        const job = await storage.getBackgroundJob(sessionId);
        if (!job) {
          return res.status(404).json({ error: 'Job not found' });
        }
        
        // Parse processing options
        const processingOptions = JSON.parse(job.processingDetails || '{}');
        
        // Start processing using the background job manager
        await backgroundJobManager.processJobBackground(job, processingOptions);
        
        res.json({ success: true, message: `Started processing job ${job.id}` });
      } else if (action === 'restart_stalled' && videoId) {
        // Clear any existing processing state
        const { enhancedProcessor } = await import('./enhanced-process.js');
        enhancedProcessor.clearJobStatus(videoId);
        
        // Find the most recent job for this video
        const jobs = await storage.getUserBackgroundJobs(`datyson.jr@gmail.com`);
        const videoJob = jobs.find((j: any) => j.videoId === videoId && j.status === 'processing');
        
        if (videoJob) {
          const processingOptions = JSON.parse(videoJob.processingDetails || '{}');
          await backgroundJobManager.processJobBackground(videoJob, processingOptions);
          res.json({ success: true, message: `Restarted job for video ${videoId}` });
        } else {
          res.status(404).json({ error: 'No processing job found for video' });
        }
      } else {
        res.status(400).json({ error: 'Invalid action or missing parameters' });
      }
    } catch (error) {
      console.error('Manual trigger error:', error);
      res.status(500).json({ error: 'Failed to execute action' });
    }
  });

  // Job monitoring and health check endpoints
  app.get('/api/job-monitor/status', async (req, res) => {
    try {
      const { jobFailureMonitor } = await import('./job-failure-monitor.js');
      const stats = jobFailureMonitor.getMonitoringStats();
      res.json({ success: true, monitoring: stats });
    } catch (error) {
      console.error('Failed to get monitoring status:', error);
      res.status(500).json({ error: 'Failed to get monitoring status' });
    }
  });

  app.get('/api/job-monitor/health/:sessionId?', async (req, res) => {
    try {
      const { jobFailureMonitor } = await import('./job-failure-monitor.js');
      const sessionId = req.params.sessionId;
      const healthMetrics = await jobFailureMonitor.checkJobHealth(sessionId);
      res.json({ success: true, healthMetrics });
    } catch (error) {
      console.error('Failed to check job health:', error);
      res.status(500).json({ error: 'Failed to check job health' });
    }
  });

  app.post('/api/job-monitor/force-check', async (req, res) => {
    try {
      const { jobFailureMonitor } = await import('./job-failure-monitor.js');
      await jobFailureMonitor.performHealthCheck();
      res.json({ success: true, message: 'Health check completed' });
    } catch (error) {
      console.error('Failed to perform health check:', error);
      res.status(500).json({ error: 'Failed to perform health check' });
    }
  });

  // Test endpoint to manually send failure email 
  app.post('/api/send-manual-failure-email', async (req, res) => {
    try {
      const { userEmail, videoName, errorMessage } = req.body;
      
      if (!userEmail || !videoName) {
        return res.status(400).json({ error: 'Missing required fields: userEmail, videoName' });
      }
      
      // Import email service directly
      const { integratedEmailWorkflow } = await import('./integrated-email-workflow.js');
      
      console.log(`📧 Sending manual failure notification to ${userEmail} for ${videoName}`);
      
      // Send failure email using export_failure template
      const emailResult = await integratedEmailWorkflow.sendEmail({
        userEmail: userEmail,
        emailType: 'export_failure' as any, // Force type since we're adding this
        sessionId: `manual-${Date.now()}`,
        videoName: videoName,
        errorMessage: errorMessage || 'Export processing failed',
        professionalQuality: true,
        skipVerification: false
      });
      
      if (emailResult.success) {
        console.log(`✅ Manual failure notification sent: ${emailResult.messageId}`);
        res.json({ 
          success: true, 
          message: `Failure notification sent to ${userEmail}`,
          messageId: emailResult.messageId
        });
      } else {
        console.error(`❌ Failed to send manual notification: ${emailResult.error}`);
        res.status(500).json({ 
          error: 'Failed to send email',
          details: emailResult.error 
        });
      }
      
    } catch (error) {
      console.error('Failed to send manual failure email:', error);
      res.status(500).json({ error: 'Failed to send failure email' });
    }
  });

  return httpServer;
}