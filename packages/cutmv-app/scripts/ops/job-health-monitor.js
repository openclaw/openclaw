// Enhanced job health monitoring and recovery system
import { storage } from './server/storage.js';
import { backgroundJobManager } from './server/background-job-manager.js';

class JobHealthMonitor {
  constructor() {
    this.checkInterval = 60 * 1000; // Check every minute
    this.stallThreshold = 5 * 60 * 1000; // 5 minutes without progress = stalled
    this.maxJobAge = 30 * 60 * 1000; // 30 minutes max job age
  }

  async start() {
    console.log('🏥 Job Health Monitor started - checking every minute for stalled jobs');
    setInterval(async () => {
      await this.checkJobHealth();
    }, this.checkInterval);
  }

  async checkJobHealth() {
    try {
      // Get all processing jobs from the database
      const allJobs = await storage.getBackgroundJobs();
      const processingJobs = allJobs.filter(job => job.status === 'processing');

      console.log(`🔍 Health check: Found ${processingJobs.length} active processing jobs`);

      for (const job of processingJobs) {
        await this.evaluateJob(job);
      }
    } catch (error) {
      console.error('❌ Job health check failed:', error);
    }
  }

  async evaluateJob(job) {
    const now = Date.now();
    const startTime = job.startedAt ? new Date(job.startedAt).getTime() : new Date(job.createdAt).getTime();
    const jobAge = now - startTime;

    // Check if job is too old
    if (jobAge > this.maxJobAge) {
      console.warn(`⚠️ Job ${job.id} has been running for ${Math.round(jobAge/60000)} minutes - marking as failed`);
      await storage.updateBackgroundJob(job.sessionId, {
        status: 'failed',
        errorMessage: `Job timed out after ${Math.round(jobAge/60000)} minutes`
      });
      return;
    }

    // Check if job is stalled (no progress update recently)
    const lastUpdate = job.updatedAt ? new Date(job.updatedAt).getTime() : startTime;
    const timeSinceUpdate = now - lastUpdate;

    if (timeSinceUpdate > this.stallThreshold && job.progress === 0) {
      console.warn(`🚨 Job ${job.id} appears stalled at ${job.progress}% - attempting restart`);
      await this.restartStalledJob(job);
    } else if (job.progress > 0) {
      console.log(`✅ Job ${job.id} is healthy - progress: ${job.progress}%`);
    }
  }

  async restartStalledJob(job) {
    try {
      console.log(`🔄 Restarting stalled job ${job.id} for video ${job.videoId}`);
      
      // Parse processing options
      const processingOptions = JSON.parse(job.processingDetails || '{}');
      
      // Clear existing processing state
      const { enhancedProcessor } = await import('./server/enhanced-process.js');
      enhancedProcessor.clearJobStatus(job.videoId);
      
      // Mark as restarting
      await storage.updateBackgroundJob(job.sessionId, {
        status: 'processing',
        progress: 0,
        startedAt: new Date()
      });

      // Restart processing
      await backgroundJobManager.processJobBackground(job, processingOptions);
      
      console.log(`✅ Job ${job.id} restart initiated`);
    } catch (error) {
      console.error(`❌ Failed to restart job ${job.id}:`, error);
      await storage.updateBackgroundJob(job.sessionId, {
        status: 'failed',
        errorMessage: `Restart failed: ${error.message}`
      });
    }
  }
}

// Start the monitor
const monitor = new JobHealthMonitor();
monitor.start();