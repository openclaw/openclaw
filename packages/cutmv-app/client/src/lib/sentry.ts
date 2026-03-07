/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import * as Sentry from "@sentry/react";

export function initializeSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  
  if (!dsn) {
    console.log('⚠️ Sentry DSN not found - error tracking disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE || 'development',
    tracesSampleRate: import.meta.env.MODE === 'production' ? 0.1 : 1.0,
    integrations: [],
    beforeSend(event) {
      // Filter out expected errors
      if (event.exception) {
        const error = event.exception.values?.[0];
        if (error?.type === 'ChunkLoadError' || error?.value?.includes('Loading chunk')) {
          return null; // Don't send chunk loading errors
        }
      }
      return event;
    },
  });

  console.log('✅ Sentry error tracking initialized (frontend)');
}

// Helper functions for structured logging
export function logUserEvent(event: string, properties?: Record<string, any>) {
  Sentry.addBreadcrumb({
    message: `User Event: ${event}`,
    category: 'user_action',
    level: 'info',
    data: properties,
  });
}

export function logVideoUpload(videoName: string, size: number, duration?: string) {
  Sentry.addBreadcrumb({
    message: 'Video Upload',
    category: 'video_processing',
    level: 'info',
    data: {
      videoName,
      size,
      duration,
      timestamp: new Date().toISOString(),
    },
  });
}

export function logPaymentEvent(event: string, amount?: number, sessionId?: string) {
  Sentry.addBreadcrumb({
    message: `Payment Event: ${event}`,
    category: 'payment',
    level: 'info',
    data: {
      event,
      amount,
      sessionId,
      timestamp: new Date().toISOString(),
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