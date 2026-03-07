// PostHog Analytics Integration for CUTMV
declare global {
  interface Window {
    posthog?: any;
  }
}

class PostHogAnalytics {
  private isEnabled: boolean = false;
  private hasConsent: boolean = false;

  constructor() {
    // Check cookie consent before initializing
    this.checkConsent();
    if (this.hasConsent) {
      this.initializePostHog();
    }
  }
  
  private checkConsent(): void {
    if (typeof window === 'undefined') return;
    
    const consent = localStorage.getItem('cutmv-cookie-consent');
    this.hasConsent = consent === 'accepted';
    
    if (!this.hasConsent) {
      console.log('🔒 Analytics tracking disabled - waiting for cookie consent');
    }
  }
  
  private initializePostHog() {
    if (typeof window === 'undefined' || !this.hasConsent) return;
    
    // Check immediately
    if (window.posthog && typeof window.posthog.capture === 'function') {
      this.isEnabled = true;
      console.log('📊 PostHog analytics initialized');
      return;
    }
    
    // Retry after a short delay for PostHog script loading
    setTimeout(() => {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        this.isEnabled = true;
        console.log('📊 PostHog analytics initialized');
      } else {
        console.log('⚠️ PostHog not available');
      }
    }, 1000);
  }

  // Enable analytics after consent
  enableAnalytics(): void {
    this.hasConsent = true;
    this.initializePostHog();
  }

  // Disable analytics
  disableAnalytics(): void {
    this.hasConsent = false;
    this.isEnabled = false;
    
    // Opt out of PostHog tracking
    if (window.posthog && typeof window.posthog.opt_out_capturing === 'function') {
      window.posthog.opt_out_capturing();
    }
  }

  // Track custom events
  track(eventName: string, properties?: Record<string, any>) {
    if (!this.isEnabled || !this.hasConsent || typeof window === 'undefined' || !window.posthog) {
      // Silently fail for analytics - don't block user actions
      return;
    }
    
    try {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        window.posthog.capture(eventName, {
          ...properties,
          timestamp: new Date().toISOString(),
          platform: 'CUTMV'
        });
      }
    } catch (error) {
      // Silently log error - don't block user actions
      console.error('PostHog tracking error:', error);
    }
  }

  // Track video uploads
  trackVideoUpload(videoData: {
    fileName: string;
    fileSize: number;
    duration?: number;
    uploadMethod: 'chunked' | 'direct';
  }) {
    this.track('video_uploaded', {
      file_name: videoData.fileName,
      file_size_mb: Math.round(videoData.fileSize / (1024 * 1024)),
      duration_seconds: videoData.duration,
      upload_method: videoData.uploadMethod,
      category: 'video_processing'
    });
  }

  // Track export selections
  trackExportSelection(exportData: {
    cutdowns: boolean;
    gifs: boolean;
    thumbnails: boolean;
    canvas: boolean;
    // Professional service only - no watermark tracking needed
    totalPrice: number;
  }) {
    this.track('export_selection_made', {
      exports_selected: {
        cutdowns: exportData.cutdowns,
        gifs: exportData.gifs,
        thumbnails: exportData.thumbnails,
        canvas: exportData.canvas
      },
      // Professional service only - no watermark tracking needed
      total_price: exportData.totalPrice,
      category: 'monetization'
    });
  }

  // Track payment events
  trackPayment(paymentData: {
    amount: number;
    currency: string;
    paymentMethod: string;
    success: boolean;
    stripeSessionId?: string;
  }) {
    this.track(paymentData.success ? 'payment_successful' : 'payment_failed', {
      amount: paymentData.amount,
      currency: paymentData.currency,
      payment_method: paymentData.paymentMethod,
      stripe_session_id: paymentData.stripeSessionId,
      category: 'payment'
    });
  }

  // Track processing completion
  trackProcessingComplete(processingData: {
    videoId: string;
    processingTime: number;
    outputCount: number;
    exportTypes: string[];
    success: boolean;
  }) {
    this.track('processing_completed', {
      video_id: processingData.videoId,
      processing_time_seconds: processingData.processingTime,
      output_count: processingData.outputCount,
      export_types: processingData.exportTypes,
      success: processingData.success,
      category: 'video_processing'
    });
  }

  // Track user engagement
  trackEngagement(action: string, details?: Record<string, any>) {
    this.track('user_engagement', {
      action,
      ...details,
      category: 'engagement'
    });
  }

  // Track blog interactions
  trackBlogInteraction(blogData: {
    action: 'view' | 'click_cta' | 'share';
    postSlug: string;
    postTitle: string;
  }) {
    this.track('blog_interaction', {
      action: blogData.action,
      post_slug: blogData.postSlug,
      post_title: blogData.postTitle,
      category: 'content_marketing'
    });
  }

  // Track feedback submissions
  trackFeedback(feedbackData: {
    type: 'feedback' | 'support';
    rating?: number;
    recommend?: boolean;
    hasEmail: boolean;
  }) {
    this.track('feedback_submitted', {
      feedback_type: feedbackData.type,
      rating: feedbackData.rating,
      would_recommend: feedbackData.recommend,
      provided_email: feedbackData.hasEmail,
      category: 'user_feedback'
    });
  }

  // Track AI metadata usage
  trackAIMetadata(metadataData: {
    triggered: boolean;
    filename: string;
    successful: boolean;
    suggestionsProvided: boolean;
  }) {
    this.track('ai_metadata_usage', {
      ai_triggered: metadataData.triggered,
      filename_pattern: metadataData.filename,
      suggestions_successful: metadataData.successful,
      suggestions_provided: metadataData.suggestionsProvided,
      category: 'ai_features'
    });
  }

  // Track page views (automatically handled by PostHog, but can be customized)
  trackPageView(pageName: string, properties?: Record<string, any>) {
    this.track('page_view', {
      page_name: pageName,
      ...properties,
      category: 'navigation'
    });
  }

  // Identify users (for logged-in users or email collection)
  identify(userId: string, userProperties?: Record<string, any>) {
    if (!this.isEnabled || !window.posthog) return;
    
    try {
      window.posthog.identify(userId, userProperties);
    } catch (error) {
      console.error('PostHog identify error:', error);
    }
  }

  // Set user properties
  setUserProperties(properties: Record<string, any>) {
    if (!this.isEnabled || !window.posthog) return;
    
    try {
      window.posthog.register(properties);
    } catch (error) {
      console.error('PostHog set properties error:', error);
    }
  }
}

// Create singleton instance
export const analytics = new PostHogAnalytics();

// Export tracking functions with proper binding to prevent "this" issues
export const track = (eventName: string, properties?: Record<string, any>) => analytics.track(eventName, properties);
export const trackVideoUpload = (videoData: any) => analytics.trackVideoUpload(videoData);
export const trackExportSelection = (exportData: any) => analytics.trackExportSelection(exportData);
export const trackPayment = (paymentData: any) => analytics.trackPayment(paymentData);
export const trackProcessingComplete = (processingData: any) => analytics.trackProcessingComplete(processingData);
export const trackEngagement = (action: string, details?: Record<string, any>) => analytics.trackEngagement(action, details);
export const trackBlogInteraction = (blogData: any) => analytics.trackBlogInteraction(blogData);
export const trackFeedback = (feedbackData: any) => analytics.trackFeedback(feedbackData);
export const trackAIMetadata = (metadataData: any) => analytics.trackAIMetadata(metadataData);
export const trackPageView = (pageName: string, properties?: Record<string, any>) => analytics.trackPageView(pageName, properties);
export const identify = (userId: string, userProperties?: Record<string, any>) => analytics.identify(userId, userProperties);
export const setUserProperties = (properties: Record<string, any>) => analytics.setUserProperties(properties);