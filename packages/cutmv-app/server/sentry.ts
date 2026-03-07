/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import * as Sentry from "@sentry/node";

export function initializeSentry() {
  console.log('🔍 Checking Sentry DSN:', {
    exists: !!process.env.SENTRY_DSN,
    length: process.env.SENTRY_DSN?.length || 0,
    starts_with: process.env.SENTRY_DSN?.substring(0, 20) || 'none'
  });
  
  if (!process.env.SENTRY_DSN) {
    console.log('⚠️ Sentry DSN not found - error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      // Filter out expected errors or sensitive data
      if (event.exception) {
        const error = event.exception.values?.[0];
        if (error?.type === 'ValidationError' || error?.value?.includes('ENOENT')) {
          return null; // Don't send validation errors or file not found errors
        }
      }
      return event;
    },
  });

  console.log('✅ Sentry error tracking initialized');
}

// Helper functions for structured logging
export function logUserEvent(userId: string, event: string, properties?: Record<string, any>) {
  Sentry.addBreadcrumb({
    message: `User Event: ${event}`,
    category: 'user_action',
    level: 'info',
    data: {
      userId,
      ...properties,
    },
  });
}

export function logVideoProcessing(sessionId: string, videoName: string, stage: string, properties?: Record<string, any>) {
  Sentry.addBreadcrumb({
    message: `Video Processing: ${stage}`,
    category: 'video_processing',
    level: 'info',
    data: {
      sessionId,
      videoName,
      stage,
      ...properties,
    },
  });
}

export function logEmailEvent(email: string, event: string, properties?: Record<string, any>) {
  Sentry.addBreadcrumb({
    message: `Email Event: ${event}`,
    category: 'email',
    level: 'info',
    data: {
      email: email.replace(/(.{2}).*(@.*)/, '$1***$2'), // Partially mask email for privacy
      event,
      ...properties,
    },
  });
}

export function captureException(error: Error, context?: Record<string, any>) {
  Sentry.withScope((scope) => {
    if (context) {
      Object.keys(context).forEach(key => {
        scope.setTag(key, context[key]);
      });
    }
    Sentry.captureException(error);
  });
}

export { Sentry };