/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - User Routes
 * User-specific API endpoints for exports and account management
 */

import { Router } from 'express';
import { requireAuth } from './auth-middleware';
import { authService } from './auth-service';
import { storage } from './storage';

const router = Router();

// All user routes require authentication
router.use(requireAuth);

// Get user's upload history - only show files that exist in R2 per-user structure
router.get('/uploads', async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'User email required' });
    }

    // Get user's videos and verify they exist in new R2 structure
    const userVideos = await storage.getUserVideos(userEmail);
    const { R2Storage } = await import('./r2-storage.js');
    
    const uploads = [];
    
    for (const video of userVideos) {
      // Show all videos, checking both expiration date AND R2 existence
      if (video.r2Key) {
        const expiresAt = video.expiresAt || new Date((video.uploadedAt?.getTime() || Date.now()) + 24 * 60 * 60 * 1000);
        const isExpiredByDate = new Date() > new Date(expiresAt);
        let isAvailableInR2 = false;
        
        // Check if file still exists in R2 (only if not expired by date)
        if (!isExpiredByDate) {
          try {
            await R2Storage.getSignedUrl(video.r2Key, 60); // Quick test URL
            isAvailableInR2 = true;
          } catch (r2Error) {
            console.log(`📂 Upload ${video.originalName} no longer exists in R2 (expired by protocol)`);
            isAvailableInR2 = false;
          }
        }
        
        // Include all uploads but mark as expired if either:
        // 1. Past the 24-hour threshold OR
        // 2. No longer available in R2 due to previous cleanup protocols
        const isExpired = isExpiredByDate || !isAvailableInR2;
        
        uploads.push({
          id: video.id,
          originalName: video.originalName,
          filename: video.originalName,
          uploadedAt: video.uploadedAt?.toISOString() || new Date().toISOString(),
          expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
          size: video.size,
          duration: video.duration,
          status: isExpired ? 'expired' : 'active',
          r2Key: video.r2Key
        });
      }
    }
    
    console.log(`📂 Found ${uploads.length} R2-verified uploads for ${userEmail}`);
    res.json({ uploads });
  } catch (error) {
    console.error('Error fetching user uploads:', error);
    res.status(500).json({ error: 'Failed to fetch uploads' });
  }
});

// Get individual video for reuse functionality
router.get('/videos/:videoId', async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'User email required' });
    }

    const videoId = parseInt(req.params.videoId);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    // Get the video and verify ownership
    const video = await storage.getVideo(videoId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Verify user owns this video
    if (video.userEmail !== userEmail) {
      return res.status(403).json({ error: 'Access denied - video belongs to another user' });
    }

    // Verify video still exists in R2
    if (video.r2Key) {
      try {
        const { R2Storage } = await import('./r2-storage.js');
        await R2Storage.getSignedUrl(video.r2Key, 60); // Quick test to verify file exists
        
        res.json({
          video: {
            id: video.id,
            originalName: video.originalName,
            videoTitle: video.videoTitle,
            size: video.size,
            duration: video.duration,
            aspectRatio: video.aspectRatio,
            format: (video as any).format || 'mp4',
            r2Key: video.r2Key,
            uploadedAt: video.uploadedAt?.toISOString(),
            expiresAt: video.expiresAt instanceof Date ? video.expiresAt.toISOString() : video.expiresAt
          }
        });
      } catch (r2Error) {
        return res.status(404).json({ error: 'Video file no longer exists' });
      }
    } else {
      return res.status(404).json({ error: 'Video file not available' });
    }
  } catch (error) {
    console.error('Error fetching video for reuse:', error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

// Get user's export history (29-day retention)
router.get('/exports', async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: 'User email required' });
    }

    // Get user's background jobs (exports) - these are the actual processing jobs
    const userJobs = await storage.getUserBackgroundJobs(userEmail);
    
    // Import download token manager to generate secure links
    const { downloadTokenManager } = await import('./download-tokens.js');
    
    const exportPromises = userJobs.map(async (job) => {
      // Calculate expiration (29 days from completion)
      const completedAt = job.completedAt ? new Date(job.completedAt) : new Date();
      const expiresAt = job.expiresAt ? new Date(job.expiresAt) : new Date(completedAt.getTime() + (29 * 24 * 60 * 60 * 1000)); // 29 days
      const isExpiredByDate = new Date() > expiresAt;
      
      // Get associated video for better naming and aspect ratio
      let originalVideoName = null;
      let videoAspectRatio = null;
      let displayName = job.downloadPath || `session_${job.sessionId}_exports.zip`;
      
      if (job.videoId) {
        const video = await storage.getVideo(job.videoId);
        if (video) {
          originalVideoName = video.originalName;
          videoAspectRatio = video.aspectRatio; // Get the correct aspect ratio from video
          // Create user-friendly display name from original video
          const baseName = video.videoTitle || video.originalName?.replace(/\.[^/.]+$/, "") || "Video";
          displayName = `${baseName} - Exports.zip`;
        }
      }
      
      // Check if files actually exist before generating download URLs
      let downloadUrl = null;
      let actualStatus = job.status;
      
      // Handle expired exports - check both database expiration and R2 file availability
      if (job.status === 'completed') {
        // Check if expired by date (29 days)
        if (isExpiredByDate) {
          actualStatus = 'expired';
          console.log(`📊 Dashboard: Export ${job.id} has expired by date (${expiresAt.toISOString()})`);
        } else if (job.downloadPath && !job.downloadPath.startsWith('user-')) {
          // For older exports that don't have per-user R2 structure, mark as expired
          actualStatus = 'expired';
          console.log(`📊 Dashboard: Export ${job.id} expired - old protocol without per-user R2 structure`);
        }
      }
      
      // Handle stalled jobs: mark as failed if pending for more than 30 minutes
      if (job.status === 'pending' && job.createdAt) {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (new Date(job.createdAt) < thirtyMinutesAgo) {
          actualStatus = 'failed';
          console.log(`📊 Dashboard: Marking stalled job ${job.id} as failed (pending > 30 min)`);
        }
      }
      
      // ALWAYS include failed exports in dashboard (no download URL needed)
      if (actualStatus === 'failed') {
        console.log(`📊 Dashboard: Including failed export ${job.id} for ${userEmail} - ${job.errorMessage}`);
        return {
          id: job.id,
          sessionId: job.sessionId,
          filename: displayName,
          downloadPath: null, // No download for failed exports
          format: 'Failed Export',
          status: actualStatus,
          progress: job.progress,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          expiresAt: expiresAt.toISOString(),
          downloadUrl: null, // No download available
          videoId: job.videoId,
          originalVideoName,
          aspectRatio: videoAspectRatio,
          errorMessage: job.errorMessage
        };
      }
      
      // Generate download URLs only for active completed exports
      if (actualStatus === 'completed' && job.downloadPath) {
        // Verify file exists in R2 before offering download
        const filename = job.downloadPath.startsWith('/api/download/') 
          ? job.downloadPath.replace('/api/download/', '') 
          : job.downloadPath;
        
        try {
          // Check NEW R2 per-user structure ONLY
          const { R2Storage } = await import('./r2-storage.js');
          
          // Try to construct the proper R2 key for per-user structure
          let r2Key: string;
          
          // Check if this job has a proper per-user R2 path
          if (job.downloadPath && job.downloadPath.startsWith('user-')) {
            r2Key = job.downloadPath; // Already in correct format
            
            // Verify file exists in R2 with 24-hour signed URL for uploads, 1 minute test for availability check
            await R2Storage.getSignedUrl(r2Key, 60); // Short test URL to verify existence
            
            // If R2 succeeds, generate secure download token (expires in 24 hours)
            const token = await downloadTokenManager.generateToken(job.sessionId, filename, userEmail, 24);
            // Use relative URL so it works on both Railway preview and production
            downloadUrl = `/api/secure-download/${token}`;
            console.log(`📊 Dashboard: Generated secure download URL for ${userEmail}: ${downloadUrl} (R2 per-user verified)`);
          } else {
            // Mark old exports that don't have per-user structure as expired
            console.log(`📊 Dashboard: Old export ${filename} marked as expired - not in per-user R2 structure`);
            actualStatus = 'expired';
            downloadUrl = null; // No download URL for expired exports
          }
        } catch (r2Error) {
          // R2 file doesn't exist or not accessible - mark as expired
          actualStatus = 'expired';
          downloadUrl = null;
          console.log(`📊 Dashboard: Export ${filename} marked as expired - R2 file not accessible`);
        }
      }

      return {
        id: job.id,
        sessionId: job.sessionId,
        filename: displayName,
        downloadPath: job.downloadPath, // Keep original path for API calls
        format: 'ZIP Package',
        status: actualStatus,
        progress: job.progress,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        expiresAt: expiresAt.toISOString(),
        downloadUrl: downloadUrl, // Always use secure download URLs, never expose R2 URLs directly
        videoId: job.videoId,
        originalVideoName,
        aspectRatio: videoAspectRatio, // Include the correct aspect ratio from source video
        errorMessage: job.errorMessage
      };
    });
    
    // Wait for all exports to process and filter out null values (skipped exports)
    const allExports = await Promise.all(exportPromises);
    const exports = allExports.filter(exp => exp !== null);
    
    console.log(`📊 Dashboard: Showing ${exports.length} per-user R2 exports for ${userEmail}`);
    res.json({ exports });
  } catch (error) {
    console.error('❌ Error getting user exports:', error);
    res.status(500).json({ error: 'Failed to get export history' });
  }
});

// Pin an export to prevent expiration (feature coming soon)
router.post('/exports/:exportId/pin', async (req, res) => {
  try {
    // Pinning feature not yet implemented
    res.status(501).json({ error: 'Pinning feature not yet implemented' });
  } catch (error) {
    console.error('❌ Error pinning export:', error);
    res.status(500).json({ error: 'Failed to pin export' });
  }
});

// Get user account info
router.get('/profile', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get export statistics from background jobs
    const userJobs = await storage.getUserBackgroundJobs(req.user.email);
    
    const stats = {
      totalExports: userJobs.length,
      activeExports: userJobs.filter(job => job.status === 'completed').length,
      processingExports: userJobs.filter(job => job.status === 'processing').length,
      failedExports: userJobs.filter(job => job.status === 'failed').length,
    };

    res.json({ 
      user: req.user,
      stats 
    });
  } catch (error) {
    console.error('❌ Error getting user profile:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// Get export preview thumbnail
router.get('/exports/:exportId/preview', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const exportId = req.params.exportId;

    // Get the background job for this export
    const job = await storage.getBackgroundJobById(parseInt(exportId));
    if (!job || job.userEmail !== req.user.email) {
      return res.status(404).json({ error: 'Export not found or access denied' });
    }

    // Get the original video to generate preview from
    if (!job.videoId) {
      return res.status(404).json({ error: 'No video associated with this export' });
    }

    const video = await storage.getVideo(job.videoId);
    if (!video || !video.r2Key) {
      return res.status(404).json({ error: 'Original video not found' });
    }

    // Generate a preview URL from the original video (first frame thumbnail)
    const { R2Storage } = await import('./r2-storage.js');

    try {
      // Get a signed URL for the original video - client will use video thumbnail
      const videoUrl = await R2Storage.getSignedUrl(video.r2Key, 300); // 5 minute preview URL

      res.json({
        previewUrl: videoUrl,
        previewType: 'video_thumbnail',
        videoId: video.id,
        originalName: video.originalName
      });
    } catch (r2Error) {
      console.error('Failed to generate preview URL:', r2Error);
      return res.status(404).json({ error: 'Preview not available' });
    }

  } catch (error) {
    console.error('Error generating export preview:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// Generate fresh download token for dashboard access
router.post('/generate-download-token', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { sessionId, filename } = req.body;
    
    if (!sessionId || !filename) {
      return res.status(400).json({ error: 'Session ID and filename required' });
    }
    
    // Verify the user owns this export
    const job = await storage.getBackgroundJob(sessionId);
    if (!job || job.userEmail !== req.user.email) {
      return res.status(403).json({ error: 'Export not found or access denied' });
    }
    
    // Generate new download token
    const { downloadTokenManager } = await import('./download-tokens.js');
    const downloadToken = await downloadTokenManager.generateToken(sessionId, filename, req.user.email, 24);

    // Use relative URL for dashboard downloads
    const downloadUrl = `/api/secure-download/${downloadToken}`;

    res.json({ downloadUrl, token: downloadToken });
  } catch (error) {
    console.error('❌ Error generating download token:', error);
    res.status(500).json({ error: 'Failed to generate download token' });
  }
});

export default router;