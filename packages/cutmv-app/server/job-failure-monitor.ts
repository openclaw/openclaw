// Comprehensive job failure detection and notification system
import { storage } from './storage.js';
import { backgroundJobManager } from './background-job-manager.js';

interface JobHealthMetrics {
  jobId: number;
  sessionId: string;
  videoId: number;
  userEmail: string;
  status: string;
  progress: number;
  createdAt: Date;
  startedAt: Date | null;
  lastActivity: Date;
  stallDuration: number; // minutes
  isStalled: boolean;
  isFailed: boolean;
  shouldRestart: boolean;
  shouldNotify: boolean;
}

class JobFailureMonitor {
  private checkInterval = 60 * 1000; // Check every minute
  private stallThreshold = 15 * 60 * 1000; // 15 minutes = stalled (allow for Canvas processing)
  private failureThreshold = 65 * 60 * 1000; // 65 minutes = failed (longer than FFmpeg max 55min)
  private restartThreshold = 25 * 60 * 1000; // 25 minutes = auto-restart (after reasonable processing time)
  private notifiedJobs = new Set<string>(); // Track notified sessions
  private isRunning = false;

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    console.log('🏥 Job Failure Monitor started - monitoring every minute');
    console.log(`⏱️ Thresholds: Stall=${this.stallThreshold/60000}min, Restart=${this.restartThreshold/60000}min, Fail=${this.failureThreshold/60000}min`);
    
    // Check for orphaned processing jobs on startup (from system restarts)
    await this.handleOrphanedJobs();
    
    // Initial check
    await this.performHealthCheck();
    
    // Schedule regular checks
    setInterval(async () => {
      await this.performHealthCheck();
    }, this.checkInterval);
  }

  /**
   * Handle jobs left in 'processing' state from system restarts
   */
  async handleOrphanedJobs() {
    try {
      console.log('🔍 Checking for orphaned jobs from system restart...');
      
      const allJobs = await storage.getUserBackgroundJobs('');
      const orphanedJobs = allJobs.filter((job: any) => job.status === 'processing');
      
      for (const job of orphanedJobs) {
        console.log(`🚫 Found orphaned processing job ${job.id} - marking as failed`);
        await storage.updateBackgroundJob(job.sessionId, {
          status: 'failed',
          errorMessage: 'Processing interrupted by system restart',
          completedAt: new Date()
        });
      }
      
      if (orphanedJobs.length > 0) {
        console.log(`✅ Cleaned up ${orphanedJobs.length} orphaned job(s)`);
      }
    } catch (error) {
      console.error('❌ Error cleaning up orphaned jobs:', error);
    }
  }

  async performHealthCheck() {
    try {
      console.log('🔍 Starting job health check...');
      
      // Get all jobs from database  
      const allJobs = await storage.getUserBackgroundJobs(''); // Get all jobs for all users
      const processingJobs = allJobs.filter((job: any) => job.status === 'processing');
      
      // Check for stuck pending jobs (created but never started processing)
      const pendingJobs = allJobs.filter((job: any) => job.status === 'pending');
      for (const pendingJob of pendingJobs) {
        const createdAt = pendingJob.createdAt ? new Date(pendingJob.createdAt).getTime() : Date.now();
        const ageInMinutes = (Date.now() - createdAt) / (1000 * 60);
        
        if (ageInMinutes > 1) { // If pending for more than 1 minute, restart it
          console.log(`🔄 Restarting stuck pending job ${pendingJob.id} (pending for ${ageInMinutes.toFixed(1)} minutes)`);
          
          try {
            const options = JSON.parse(pendingJob.processingDetails || '{}');
            // Update status to processing and trigger background processing
            await storage.updateBackgroundJob(pendingJob.sessionId, {
              status: 'processing',
              startedAt: new Date(),
              progress: 0
            });
            
            // Restart the job processing
            await backgroundJobManager.processJobBackground(pendingJob, options);
            console.log(`✅ Successfully restarted pending job ${pendingJob.id}`);
          } catch (restartError) {
            console.error(`❌ Failed to restart pending job ${pendingJob.id}:`, restartError);
            await storage.updateBackgroundJob(pendingJob.sessionId, {
              status: 'failed',
              errorMessage: `Failed to restart pending job: ${restartError instanceof Error ? restartError.message : 'Unknown error'}`,
              completedAt: new Date()
            });
          }
        }
      }
      
      // Check for failed jobs that haven't been notified (immediate failures)
      const failedJobs = allJobs.filter((job: any) => 
        job.status === 'failed' && 
        !this.notifiedJobs.has(job.sessionId)
      );
      
      // Send failure notifications for immediate failures
      for (const failedJob of failedJobs) {
        console.log(`📧 Detected unnotified failed job ${failedJob.id} - sending failure email`);
        const metrics: JobHealthMetrics = {
          jobId: failedJob.id,
          sessionId: failedJob.sessionId,
          videoId: failedJob.videoId || 0,
          userEmail: failedJob.userEmail,
          status: failedJob.status,
          progress: failedJob.progress,
          createdAt: failedJob.createdAt ? new Date(failedJob.createdAt) : new Date(),
          startedAt: failedJob.startedAt ? new Date(failedJob.startedAt) : null,
          lastActivity: failedJob.createdAt ? new Date(failedJob.createdAt) : new Date(),
          stallDuration: 0,
          isStalled: false,
          isFailed: true,
          shouldRestart: false,
          shouldNotify: true
        };
        
        await this.sendFailureNotification(metrics);
        this.notifiedJobs.add(failedJob.sessionId);
      }
      
      // First, perform immediate cleanup of obviously stuck jobs (24+ hours old)
      const now = Date.now();
      const stalledJobs = processingJobs.filter((job: any) => {
        const createdAt = new Date(job.createdAt).getTime();
        const ageInHours = (now - createdAt) / (1000 * 60 * 60);
        return ageInHours > 24; // Jobs older than 24 hours are definitely failed
      });
      
      for (const stalledJob of stalledJobs) {
        const ageInHours = Math.round((now - new Date(stalledJob.createdAt || new Date()).getTime()) / (1000 * 60 * 60));
        console.log(`🧹 Auto-failing obviously stuck job ${stalledJob.id} (${ageInHours} hours old)`);
        await storage.updateBackgroundJob(stalledJob.sessionId, {
          status: 'failed',
          errorMessage: `Job automatically failed after ${ageInHours} hours`,
          completedAt: new Date()
        });
      }
      
      // After cleanup, filter out the failed jobs 
      const remainingProcessingJobs = processingJobs.filter((job: any) => 
        !stalledJobs.some((stalledJob: any) => stalledJob.id === job.id)
      );
      
      if (remainingProcessingJobs.length === 0) {
        console.log('✅ No active processing jobs to monitor');
        return;
      }
      
      console.log(`🔍 Monitoring ${remainingProcessingJobs.length} active processing jobs`);
      
      const healthMetrics = await Promise.all(
        remainingProcessingJobs.map((job: any) => this.analyzeJobHealth(job))
      );
      
      // Handle each job based on its health status
      for (const metrics of healthMetrics) {
        await this.handleJobHealth(metrics);
      }
      
      console.log('✅ Job health check completed');
    } catch (error) {
      console.error('❌ Job health check failed:', error);
    }
  }

  private async analyzeJobHealth(job: any): Promise<JobHealthMetrics> {
    const now = Date.now();
    const createdAt = new Date(job.createdAt);
    const startedAt = job.startedAt ? new Date(job.startedAt) : null;
    const lastActivity = startedAt || createdAt;
    
    const jobAge = now - createdAt.getTime();
    const timeSinceStart = startedAt ? now - startedAt.getTime() : jobAge;
    const timeSinceActivity = now - lastActivity.getTime();
    
    // Get adaptive timeout for this specific job based on its processing details
    let adaptiveFailureThreshold = this.failureThreshold; // Default fallback
    
    try {
      if (job.processingDetails) {
        const processingDetails = JSON.parse(job.processingDetails);
        const video = await storage.getVideo(job.videoId);
        
        if (video) {
          const { enhancedProcessor } = await import('./enhanced-process.js');
          
          // Calculate operations for this job
          const operations = [];
          if (processingDetails.generateCutdowns && processingDetails.timestamps?.length > 0) {
            for (let i = 0; i < processingDetails.timestamps.length; i++) {
              operations.push({ type: 'cutdown' });
            }
          }
          if (processingDetails.generateGif) {
            const videoDuration = parseFloat(video.duration?.replace(/[^\d.]/g, '') || '0');
            const gifCount = videoDuration < 40 ? 5 : 10;
            for (let i = 0; i < gifCount; i++) operations.push({ type: 'gif' });
          }
          if (processingDetails.generateThumbnails) {
            const videoDuration = parseFloat(video.duration?.replace(/[^\d.]/g, '') || '0');
            const thumbnailCount = videoDuration < 40 ? 5 : 10;
            for (let i = 0; i < thumbnailCount; i++) operations.push({ type: 'thumbnail' });
          }
          if (processingDetails.generateCanvas && processingDetails.timestamps?.length > 0) {
            for (let i = 0; i < processingDetails.timestamps.length; i++) {
              operations.push({ type: 'canvas' });
            }
          }
          
          // Create minimal operations structure for complexity calculation
          const minimalOperations = operations.map((op, index) => ({
            type: op.type as 'cutdown' | 'gif' | 'thumbnail' | 'canvas',
            id: `${op.type}_${index}`,
            inputPath: '',
            outputPath: '',
            options: {},
            status: 'pending' as const,
            progress: 0,
            duration: 0
          }));
          
          const complexity = enhancedProcessor.calculateProcessingComplexity(minimalOperations, video, processingDetails);
          adaptiveFailureThreshold = enhancedProcessor.calculateAdaptiveTimeout(complexity);
          
          console.log(`📊 Job ${job.id} adaptive failure threshold: ${Math.round(adaptiveFailureThreshold/60000)} minutes (${complexity.operationCount} ops, ${complexity.fileSizeGB}GB, ${complexity.exportTypes} types)`);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Could not calculate adaptive threshold for job ${job.id}, using default:`, error);
    }
    
    const isStalled = timeSinceActivity > this.stallThreshold && job.progress <= 5;
    const shouldRestart = timeSinceActivity > this.restartThreshold && job.progress <= 5;
    const isFailed = timeSinceStart > adaptiveFailureThreshold; // Use adaptive threshold
    const shouldNotify = (isStalled || isFailed) && !this.notifiedJobs.has(job.sessionId);
    
    return {
      jobId: job.id,
      sessionId: job.sessionId,
      videoId: job.videoId || 0,
      userEmail: job.userEmail,
      status: job.status,
      progress: job.progress,
      createdAt,
      startedAt,
      lastActivity,
      stallDuration: Math.round(timeSinceActivity / 60000),
      isStalled,
      isFailed,
      shouldRestart,
      shouldNotify
    };
  }

  private async handleJobHealth(metrics: JobHealthMetrics) {
    const { sessionId, videoId, userEmail, stallDuration, isStalled, isFailed, shouldRestart, shouldNotify } = metrics;
    
    console.log(`📊 Job ${metrics.jobId}: stalled=${isStalled}, failed=${isFailed}, restart=${shouldRestart}, notify=${shouldNotify}, idle=${stallDuration}min`);
    
    // Handle failure notification
    if (shouldNotify) {
      await this.sendFailureNotification(metrics);
      this.notifiedJobs.add(sessionId);
    }
    
    // Handle automatic restart for stalled jobs
    if (shouldRestart && !isFailed) {
      console.log(`🔄 Auto-restarting stalled job ${metrics.jobId} (idle for ${stallDuration} minutes)`);
      await this.restartStalledJob(metrics);
    }
    
    // Handle permanent failure - conservative failure detection
    if (isFailed || stallDuration > 85) { // Only fail jobs idle for 85+ minutes (aligned with unified deadline system max)
      console.log(`❌ Marking job ${metrics.jobId} as permanently failed (idle for ${stallDuration} minutes)`);
      await this.markJobAsFailed(metrics, `Job failed after ${stallDuration} minutes of inactivity`);
    }
  }

  private async sendFailureNotification(metrics: JobHealthMetrics) {
    try {
      console.log(`📧 Sending failure notification for job ${metrics.jobId} to ${metrics.userEmail}`);
      
      // Get video information for the notification
      const video = await storage.getVideo(metrics.videoId);
      const videoName = video?.originalName || `Video ${metrics.videoId}`;
      
      // Import email service
      const { integratedEmailWorkflow } = await import('./integrated-email-workflow.js');
      
      let emailType: string;
      let subject: string;
      let message: string;
      
      if (metrics.isFailed) {
        const emailResult = await integratedEmailWorkflow.sendEmail({
          userEmail: metrics.userEmail,
          emailType: 'export_failure' as any,
          sessionId: metrics.sessionId,
          videoName,
          errorMessage: `Export failed after ${metrics.stallDuration} minutes of processing`,
          professionalQuality: true,
          skipVerification: false
        });

        if (emailResult.success) {
          console.log(`✅ Failure notification sent: ${emailResult.messageId}`);
        } else {
          console.error(`❌ Failed to send notification: ${emailResult.error}`);
        }
        return;
      } else if (metrics.isStalled) {
        const emailResult = await integratedEmailWorkflow.sendEmail({
          userEmail: metrics.userEmail,
          emailType: 'processing_started' as any,
          sessionId: metrics.sessionId,
          videoName,
          estimatedTime: `${metrics.stallDuration} minutes (restarting)`,
          professionalQuality: true,
          skipVerification: false
        });

        if (emailResult.success) {
          console.log(`✅ Stall notification sent: ${emailResult.messageId}`);
        } else {
          console.error(`❌ Failed to send stall notification: ${emailResult.error}`);
        }
        return;
      } else {
        return; // No notification needed
      }
      

      
    } catch (error) {
      console.error(`❌ Error sending failure notification for job ${metrics.jobId}:`, (error as Error).message);
    }
  }

  private async restartStalledJob(metrics: JobHealthMetrics) {
    try {
      // Get job from database
      const job = await storage.getBackgroundJob(metrics.sessionId);
      if (!job) {
        console.error(`❌ Cannot restart - job not found: ${metrics.sessionId}`);
        return;
      }
      
      // Parse processing options
      const processingOptions = JSON.parse(job.processingDetails || '{}');
      
      // Clear existing processing state
      const { enhancedProcessor } = await import('./enhanced-process.js');
      enhancedProcessor.clearJobStatus(metrics.videoId);
      
      // Reset job status
      await storage.updateBackgroundJob(metrics.sessionId, {
        status: 'processing',
        progress: 0,
        startedAt: new Date(),
        errorMessage: null
      });
      
      // Restart processing
      await backgroundJobManager.processJobBackground(job, processingOptions);
      
      console.log(`✅ Successfully restarted job ${metrics.jobId}`);
      
      // Remove from notified set so we can notify again if it fails again
      this.notifiedJobs.delete(metrics.sessionId);
      
    } catch (error) {
      console.error(`❌ Failed to restart job ${metrics.jobId}:`, error);
      await this.markJobAsFailed(metrics, `Restart failed: ${(error as Error).message}`);
    }
  }

  private async markJobAsFailed(metrics: JobHealthMetrics, errorMessage: string) {
    try {
      await storage.updateBackgroundJob(metrics.sessionId, {
        status: 'failed',
        errorMessage,
        completedAt: new Date()
      });
      
      console.log(`💾 Job ${metrics.jobId} marked as failed: ${errorMessage}`);
      
      // Send final failure notification if not already sent
      if (!this.notifiedJobs.has(metrics.sessionId)) {
        await this.sendFailureNotification({
          ...metrics,
          isFailed: true,
          shouldNotify: true
        });
        this.notifiedJobs.add(metrics.sessionId);
      }
      
    } catch (error) {
      console.error(`❌ Failed to mark job ${metrics.jobId} as failed:`, error);
    }
  }

  // Manual health check endpoint
  async checkJobHealth(sessionId?: string): Promise<JobHealthMetrics[]> {
    const allJobs = await storage.getUserBackgroundJobs(''); // Get all jobs
    const jobsToCheck = sessionId 
      ? allJobs.filter((job: any) => job.sessionId === sessionId)
      : allJobs.filter((job: any) => job.status === 'processing');
    
    return Promise.all(jobsToCheck.map((job: any) => this.analyzeJobHealth(job)));
  }

  // Clear notification flag to allow re-sending notifications
  clearNotificationFlag(sessionId: string) {
    this.notifiedJobs.delete(sessionId);
    console.log(`🔄 Cleared notification flag for session ${sessionId}`);
  }

  // Expose failure notification for manual testing (public method)
  async sendFailureEmail(metrics: JobHealthMetrics) {
    return this.sendFailureNotification(metrics);
  }

  // Get monitoring statistics
  getMonitoringStats() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval / 1000,
      stallThreshold: this.stallThreshold / 60000,
      restartThreshold: this.restartThreshold / 60000,
      failureThreshold: this.failureThreshold / 60000,
      notifiedJobsCount: this.notifiedJobs.size
    };
  }
}

export const jobFailureMonitor = new JobFailureMonitor();