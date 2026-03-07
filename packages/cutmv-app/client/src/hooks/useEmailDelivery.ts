/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState, useCallback } from 'react';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';

interface BackgroundJobResponse {
  success: boolean;
  message: string;
  jobId?: string;
  sessionId?: string;
  backgroundProcessing?: boolean;
  emailDelivery?: boolean;
  error?: string;
}

interface BackgroundJobStatus {
  id: number;
  status: string;
  progress: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  downloadPath?: string;
  r2DownloadUrl?: string;
  errorMessage?: string;
}

interface BackgroundJobStatusResponse {
  success: boolean;
  job?: BackgroundJobStatus;
  message?: string;
}

interface ProcessingOptions {
  videoId: number;
  userEmail: string;
  timestampText: string;
  quality?: string;
  aspectRatios?: ('16:9' | '9:16')[];
  generateGif?: boolean;
  generateThumbnails?: boolean;
  generateCanvas?: boolean;
  videoFade?: boolean;
  audioFade?: boolean;
  fadeDuration?: number;
  sessionId: string;
}

export function useEmailDelivery() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [jobStatus, setJobStatus] = useState<BackgroundJobStatus | null>(null);
  const { toast } = useToast();

  const startBackgroundProcessing = useCallback(async (options: ProcessingOptions): Promise<BackgroundJobResponse> => {
    setIsProcessing(true);
    
    try {
      const response = await apiRequest('POST', '/api/process-with-email', options);

      const data = await response.json() as BackgroundJobResponse;

      if (data.success) {
        toast({
          title: "Background Processing Started",
          description: "Your video is being processed. You'll receive an email with download links when complete.",
          variant: "default",
        });
      } else {
        toast({
          title: "Processing Failed",
          description: data.message || "Failed to start background processing",
          variant: "destructive",
        });
      }

      return data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast({
        title: "Processing Error",
        description: errorMessage,
        variant: "destructive",
      });
      
      return {
        success: false,
        message: errorMessage
      };
    } finally {
      setIsProcessing(false);
    }
  }, [toast]);

  const getJobStatus = useCallback(async (sessionId: string): Promise<BackgroundJobStatus | null> => {
    try {
      const response = await apiRequest('GET', `/api/background-job/${sessionId}`);
      const data = await response.json() as BackgroundJobStatusResponse;
      
      if (data.success && data.job) {
        setJobStatus(data.job);
        return data.job;
      }
      
      return null;
    } catch (error) {
      console.error('Failed to get job status:', error);
      return null;
    }
  }, []);

  const cancelJob = useCallback(async (sessionId: string): Promise<boolean> => {
    try {
      const response = await apiRequest('POST', `/api/background-job/${sessionId}/cancel`);

      const data = await response.json() as { success: boolean; message: string };

      if (data.success) {
        toast({
          title: "Job Cancelled",
          description: "Background processing has been cancelled",
          variant: "default",
        });
        setJobStatus(null);
      }

      return data.success;
    } catch (error) {
      toast({
        title: "Cancel Failed",
        description: "Failed to cancel background job",
        variant: "destructive",
      });
      return false;
    }
  }, [toast]);

  const testEmailService = useCallback(async (): Promise<boolean> => {
    try {
      const response = await apiRequest('GET', '/api/email/test');
      const data = await response.json() as { success: boolean; message: string; error?: string };
      
      toast({
        title: data.success ? "Email Test Successful" : "Email Test Failed",
        description: data.message,
        variant: data.success ? "default" : "destructive",
      });

      return data.success;
    } catch (error) {
      toast({
        title: "Email Test Error",
        description: "Failed to test email service",
        variant: "destructive",
      });
      return false;
    }
  }, [toast]);

  const sendWelcomeEmail = useCallback(async (userEmail: string, firstName?: string): Promise<boolean> => {
    try {
      const response = await apiRequest('POST', '/api/send-welcome-email', {
        userEmail,
        firstName
      });

      const data = await response.json() as { success: boolean; message: string; error?: string };

      if (data.success) {
        console.log('Welcome email sent successfully to:', userEmail);
        return true;
      } else {
        console.error('Welcome email failed:', data.error);
        return false;
      }
    } catch (error) {
      console.error('Welcome email error:', error);
      return false;
    }
  }, []);

  return {
    isProcessing,
    jobStatus,
    startBackgroundProcessing,
    getJobStatus,
    cancelJob,
    testEmailService,
    sendWelcomeEmail,
  };
}