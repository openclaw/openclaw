#!/usr/bin/env node

// Manual trigger for stuck background jobs
// This script manually starts processing for stuck jobs

import { storage } from './server/storage.js';
import { backgroundJobManager } from './server/background-job-manager.js';

async function triggerStuckJob() {
  try {
    console.log('🔧 Manual job trigger starting...');
    
    // Get the stuck processing job
    const jobs = await storage.getUserBackgroundJobs('');
    const processingJobs = jobs.filter(job => job.status === 'processing');
    
    console.log(`Found ${processingJobs.length} processing jobs`);
    
    for (const job of processingJobs) {
      console.log(`\n🔄 Processing job ${job.id} (session: ${job.sessionId})`);
      console.log(`   Video: ${job.videoId}`);
      console.log(`   Status: ${job.status}`);
      console.log(`   Progress: ${job.progress}%`);
      
      // Parse processing options
      const options = JSON.parse(job.processingDetails || '{}');
      console.log(`   Options:`, options);
      
      // Manually trigger the processing
      console.log(`🚀 Starting background processing...`);
      await backgroundJobManager.processJobBackground(job, options);
      
      console.log(`✅ Processing triggered for job ${job.id}`);
    }
    
    if (processingJobs.length === 0) {
      console.log('No processing jobs found to trigger');
    }
    
  } catch (error) {
    console.error('❌ Manual trigger failed:', error);
  }
}

// Run the trigger
triggerStuckJob().then(() => {
  console.log('🏁 Manual trigger completed');
}).catch(error => {
  console.error('💥 Manual trigger crashed:', error);
});