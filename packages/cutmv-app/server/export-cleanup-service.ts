/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Export Cleanup Service
 * Handles file expiration and cleanup for user exports
 */

import { db } from './db';
import { exports } from '@shared/schema';
import { eq, lt, and } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';
import R2Storage from './r2-storage';

class ExportCleanupService {
  private intervalId: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup service
    this.startCleanupScheduler();
  }

  private startCleanupScheduler() {
    // Run cleanup every 6 hours
    this.intervalId = setInterval(() => {
      this.cleanupExpiredExports().catch(error => {
        console.error('❌ Export cleanup error:', error);
      });
    }, 6 * 60 * 60 * 1000); // 6 hours

    // Run initial cleanup on startup
    this.cleanupExpiredExports().catch(error => {
      console.error('❌ Initial export cleanup error:', error);
    });

    console.log('🧹 Export cleanup service started - running every 6 hours');
  }

  async cleanupExpiredExports() {
    try {
      console.log('🧹 Starting expired exports cleanup...');

      // Find all expired exports (universal 29-day retention)
      const expiredExports = await db
        .select()
        .from(exports)
        .where(
          and(
            lt(exports.expiresAt, new Date()),
            eq(exports.status, 'completed')
          )
        );

      console.log(`Found ${expiredExports.length} expired exports to clean up`);

      for (const exportItem of expiredExports) {
        try {
          // Update export status to expired
          await db
            .update(exports)
            .set({ status: 'expired' })
            .where(eq(exports.id, exportItem.id));

          // Clean up files
          await this.cleanupExportFiles(exportItem);

          console.log(`✅ Cleaned up expired export: ${exportItem.filename}`);
        } catch (error) {
          console.error(`❌ Failed to cleanup export ${exportItem.filename}:`, error);
        }
      }

      console.log('✅ Export cleanup completed');
    } catch (error) {
      console.error('❌ Export cleanup service error:', error);
    }
  }

  private async cleanupExportFiles(exportItem: any) {
    // Clean up R2 file if exists
    if (exportItem.r2Key) {
      try {
        await R2Storage.deleteFile(exportItem.r2Key);
        console.log(`🗑️ Deleted R2 file: ${exportItem.r2Key}`);
      } catch (r2Error) {
        console.warn(`⚠️ Could not delete R2 file ${exportItem.r2Key}:`, r2Error);
      }
    }

    // Clean up local file if exists
    if (exportItem.downloadUrl && exportItem.downloadUrl.startsWith('/api/download/')) {
      try {
        const filename = exportItem.downloadUrl.replace('/api/download/', '');
        const localPath = path.join('uploads', 'clips', filename);
        await fs.unlink(localPath);
        console.log(`🗑️ Deleted local file: ${localPath}`);
      } catch (localError) {
        console.warn(`⚠️ Could not delete local file:`, localError);
      }
    }
  }

  async sendExpirationReminders() {
    try {
      console.log('📧 Checking for exports needing expiration reminders...');

      // Find exports expiring within 24 hours (not pinned, not expired, completed)
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const expiringExports = await db
        .select()
        .from(exports)
        .where(
          and(
            lt(exports.expiresAt, tomorrow),
            // eq(exports.pinned, false), // Feature not implemented yet
            eq(exports.status, 'completed')
          )
        );

      // TODO: Send reminder emails via Resend
      console.log(`Found ${expiringExports.length} exports expiring within 24 hours`);

      return expiringExports;
    } catch (error) {
      console.error('❌ Error checking expiration reminders:', error);
      return [];
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 Export cleanup service stopped');
    }
  }
}

export const exportCleanupService = new ExportCleanupService();