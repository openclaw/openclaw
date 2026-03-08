#!/usr/bin/env node
/**
 * watchdog.js - Node.js Fallback Wake Scheduler
 * 
 * This watchdog process runs continuously and sends wake signals to OpenClaw
 * when OS-level scheduling (Task Scheduler, Cron, Systemd, Launchd) is unavailable.
 * 
 * @version 1.2.0-production
 * @license MIT
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execFileAsync = promisify(execFile);

// Configuration
const ACTIVE_INTERVAL = 5 * 60 * 1000;  // 5 minutes
const SLEEP_INTERVAL = 15 * 60 * 1000;  // 15 minutes
const ACTIVE_HOURS_START = 7;  // 7 AM
const ACTIVE_HOURS_END = 2;    // 2 AM (next day)
const LOG_FILE = path.join(__dirname, 'watchdog.log');

// Get openclaw path from environment or default
const OPENCLAW_PATH = process.env.OPENCLAW_PATH || 'openclaw';

// Logging helper
async function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(message);
  
  try {
    // Check log size and rotate if needed
    const stats = await fs.stat(LOG_FILE).catch(() => ({ size: 0 }));
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      await fs.rename(LOG_FILE, `${LOG_FILE}.1`).catch(() => {});
    }
    
    await fs.appendFile(LOG_FILE, logLine);
  } catch (error) {
    // Silent fail on log errors
  }
}

// Determine if we're in active hours
function isActiveHours() {
  const hour = new Date().getHours();
  
  // Handle wrap-around (e.g., 7 AM - 2 AM next day)
  if (ACTIVE_HOURS_START < ACTIVE_HOURS_END) {
    return hour >= ACTIVE_HOURS_START && hour < ACTIVE_HOURS_END;
  } else {
    return hour >= ACTIVE_HOURS_START || hour < ACTIVE_HOURS_END;
  }
}

// Send wake signal
async function wake() {
  try {
    const startTime = Date.now();
    const { stdout, stderr } = await execFileAsync(
      OPENCLAW_PATH,
      ['wake', '--text', 'Watchdog pulse'],
      { timeout: 10000, windowsHide: true }
    );
    
    const duration = Date.now() - startTime;
    const output = stdout.trim();
    
    if (output) {
      await log(`✅ Wake signal sent (${duration}ms): ${output}`);
    } else {
      await log(`✅ Wake signal sent (${duration}ms)`);
    }
    
    return true;
  } catch (error) {
    await log(`❌ Wake failed: ${error.message}`);
    return false;
  }
}

// Main watchdog loop
async function watchdog() {
  await log('🐕 Watchdog started');
  await log(`OpenClaw path: ${OPENCLAW_PATH}`);
  await log(`Active hours: ${ACTIVE_HOURS_START}:00 - ${ACTIVE_HOURS_END}:00`);
  await log(`Active interval: ${ACTIVE_INTERVAL / 1000 / 60} minutes`);
  await log(`Sleep interval: ${SLEEP_INTERVAL / 1000 / 60} minutes`);
  
  // Send immediate wake on startup
  await wake();
  
  // Dynamic interval that recalculates on each iteration
  async function scheduleNext() {
    const interval = isActiveHours() ? ACTIVE_INTERVAL : SLEEP_INTERVAL;
    const nextWake = new Date(Date.now() + interval);
    await log(`Next wake: ${nextWake.toLocaleString()}`);
    
    setTimeout(async () => {
      await wake();
      await scheduleNext(); // Reschedule with potentially different interval
    }, interval);
  }
  
  // Start the dynamic scheduling
  await scheduleNext();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await log('🛑 Watchdog shutting down (SIGINT)');
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await log('🛑 Watchdog shutting down (SIGTERM)');
    process.exit(0);
  });
  
  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    await log(`💥 Uncaught exception: ${error.message}`);
    await log('Watchdog will continue running...');
  });
  
  process.on('unhandledRejection', async (reason) => {
    await log(`💥 Unhandled rejection: ${reason}`);
    await log('Watchdog will continue running...');
  });
}

// Start watchdog if run directly
if (require.main === module) {
  watchdog().catch(async (error) => {
    await log(`💥 Fatal error: ${error.message}`);
    console.error('Watchdog crashed:', error);
    process.exit(1);
  });
}

module.exports = { wake, watchdog };
