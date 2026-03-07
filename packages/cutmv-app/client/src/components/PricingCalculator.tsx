/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState, useEffect } from "react";
import { CreditCard, Calculator, Scissors, FileImage, Image, Shuffle, HelpCircle, Upload, Film, ExternalLink, Mail, Clock, X, Volume2 } from "lucide-react";
import { SiSpotify } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useEmailDelivery } from "@/hooks/useEmailDelivery";
import { useEmailVerification } from "@/hooks/useEmailVerification";
import { logUserEvent, logPaymentEvent } from "@/lib/sentry";
import { trackExportSelection, trackPayment, trackEngagement } from "@/lib/posthog";
import VideoUpload from "@/components/VideoUpload";
import TimestampInput from "@/components/TimestampInput";
import { useAuth } from "@/components/AuthGuard";
import type { Video } from "@shared/schema";

interface PricingCalculatorProps {
  onPaymentRequired: (sessionId: string, paymentConfig: PaymentConfig) => void;
  onFreeSessionCreated?: (sessionId: string, paymentConfig: PaymentConfig) => void;
  defaultConfig?: Partial<PaymentConfig>;
  videoMetadata?: { duration: string };
  onVideoUpload?: (video: Video) => void;
  uploadedVideo?: Video | null;
  onTimestampTextChange?: (text: string) => void;
  generateCutdowns: boolean;
  setGenerateCutdowns: (value: boolean) => void;
  onTimestampsGenerated?: (timestampText: string) => void;
  onRegisterGenerateFunction?: (generateFn: () => void) => void;
}

interface PaymentConfig {
  timestampText: string;
  aspectRatios: ('16:9' | '9:16')[];
  generateGif: boolean;
  generateThumbnails: boolean;
  generateCanvas: boolean;
  useFullPack: boolean;
  userEmail?: string;
  videoFade?: boolean;
  audioFade?: boolean;
  fadeDuration?: number;
  // Removed watermark functionality - CUTMV is now paid-only with clean exports
}

interface PricingData {
  cutdown16x9: number;
  cutdown9x16: number;
  spotifyCanvas: number;
  gifPack: number;
  thumbnailPack: number;
  fullFeaturePack: number;
  // Subscriber-aware pricing
  cutdown: number;
  canvasPack: number;
  isSubscriber: boolean;
  subscriberDiscount: number;
  subscriberRates: {
    cutdown: number;
    gifPack: number;
    thumbnailPack: number;
    canvasPack: number;
  };
  nonSubscriberRates: {
    cutdown: number;
    gifPack: number;
    thumbnailPack: number;
    canvasPack: number;
  };
}

export default function PricingCalculator({ onPaymentRequired, onFreeSessionCreated, defaultConfig, videoMetadata, onVideoUpload, uploadedVideo, onTimestampTextChange, generateCutdowns, setGenerateCutdowns, onTimestampsGenerated, onRegisterGenerateFunction }: PricingCalculatorProps) {
  // Get authenticated user
  const { user } = useAuth();

  // Local video state to handle uploads within this component
  const [localUploadedVideo, setLocalUploadedVideo] = useState<Video | null>(uploadedVideo || null);
  
  // Update local state when prop changes
  useEffect(() => {
    if (uploadedVideo) {
      console.log('PricingCalculator: Updating local video state from prop:', uploadedVideo);
      setLocalUploadedVideo(uploadedVideo);

      // Apply smart aspect ratio defaults when video uploads
      if (uploadedVideo.aspectRatio) {
        console.log(`📐 Applying smart aspect ratio default: ${uploadedVideo.aspectRatio}`);
        setConfig(prev => {
          // Only apply smart default if no aspect ratios currently selected
          if (prev.aspectRatios.length === 0) {
            return {
              ...prev,
              aspectRatios: [uploadedVideo.aspectRatio as '16:9' | '9:16']
            };
          }
          return prev;
        });
      }
    }
  }, [uploadedVideo]);
  


  // FORM PERSISTENCE: Initialize with localStorage backup to preserve user input
  const [config, setConfig] = useState<PaymentConfig>(() => {
    if (typeof window === 'undefined') {
      return {
        timestampText: defaultConfig?.timestampText || '',
        aspectRatios: defaultConfig?.aspectRatios || [],
        generateGif: defaultConfig?.generateGif || false,
        generateThumbnails: defaultConfig?.generateThumbnails || false,
        generateCanvas: defaultConfig?.generateCanvas || false,
        useFullPack: false,
        userEmail: defaultConfig?.userEmail || '',
        videoFade: false,
        audioFade: false,
        fadeDuration: 0.5,
        // CUTMV is now paid-only service - no watermark options needed
      };
    }

    // Load saved form data from localStorage
    const savedTimestamps = localStorage.getItem('cutmv-timestamp-text');
    const savedEmail = localStorage.getItem('cutmv-user-email');
    const savedGif = localStorage.getItem('cutmv-generate-gif') === 'true';
    const savedThumbnails = localStorage.getItem('cutmv-generate-thumbnails') === 'true';
    const savedCanvas = localStorage.getItem('cutmv-generate-canvas') === 'true';
    const savedVideoFade = localStorage.getItem('cutmv-video-fade') === 'true';
    const savedAudioFade = localStorage.getItem('cutmv-audio-fade') === 'true';
    const savedFadeDuration = parseFloat(localStorage.getItem('cutmv-fade-duration') || '0.5');

    return {
      timestampText: defaultConfig?.timestampText || savedTimestamps || '',
      aspectRatios: defaultConfig?.aspectRatios || [],
      generateGif: defaultConfig?.generateGif ?? savedGif,
      generateThumbnails: defaultConfig?.generateThumbnails ?? savedThumbnails,
      generateCanvas: defaultConfig?.generateCanvas ?? savedCanvas,
      useFullPack: false,
      userEmail: '', // Will be set by useEffect
      videoFade: savedVideoFade,
      audioFade: savedAudioFade,
      fadeDuration: savedFadeDuration,
      // CUTMV is now paid-only service - no watermark options needed
    };
  });

  const [generatedTimestamps, setGeneratedTimestamps] = useState<string>('');
  
  const [pricing, setPricing] = useState<PricingData | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [originalAmount, setOriginalAmount] = useState(0);
  const [discountApplied, setDiscountApplied] = useState(0);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isCreatingCheckout, setIsCreatingCheckout] = useState(false);
  const [discountCode, setDiscountCode] = useState('');
  const [showPromoInput, setShowPromoInput] = useState(false);
  const [promoValidation, setPromoValidation] = useState<any>(null);
  const [isValidatingPromo, setIsValidatingPromo] = useState(false);

  // Subscriber-aware pricing state
  const [isSubscriber, setIsSubscriber] = useState(false);
  const [subscriberCost, setSubscriberCost] = useState(0);
  const [potentialSavings, setPotentialSavings] = useState(0);
  const { toast } = useToast();
  const { sendWelcomeEmail } = useEmailDelivery();
  const { verifyEmail, isVerifying: isVerifyingEmail, lastResult: emailVerificationResult } = useEmailVerification();

  // Automatically populate authenticated user's email
  useEffect(() => {
    if (user?.email && !config.userEmail) {
      setConfig(prev => ({ ...prev, userEmail: user.email }));
    }
  }, [user?.email, config.userEmail]);

  // Load saved email and reset toggles when video is reselected from dashboard
  useEffect(() => {
    if (uploadedVideo && typeof window !== 'undefined') {
      // Always load saved email if available
      const savedEmail = localStorage.getItem('cutmv-user-email');
      if (savedEmail && !config.userEmail) {
        console.log('🔄 PricingCalculator: Loading saved email for reselected video:', savedEmail);
        setConfig(prev => ({ ...prev, userEmail: savedEmail }));
      }
      
      // Reset all export toggles to false for fresh start when reselecting video
      console.log('🔄 PricingCalculator: Resetting export toggles for reselected video');
      setConfig(prev => ({ 
        ...prev, 
        generateGif: false,
        generateThumbnails: false,
        generateCanvas: false,
        useFullPack: false,
        timestampText: ''
      }));
      
      // Reset cutdowns toggle as well
      setGenerateCutdowns(false);
    }
  }, [uploadedVideo]);

  // Register the generate timestamps function with the parent component
  useEffect(() => {
    if (onRegisterGenerateFunction) {
      onRegisterGenerateFunction(generateRandomTimestamps);
    }
  }, [onRegisterGenerateFunction]);

  // Load pricing on mount
  useEffect(() => {
    const loadPricing = async () => {
      try {
        const response = await apiRequest("GET", "/api/pricing");
        const data = await response.json();
        setPricing(data);
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to load pricing information",
          variant: "destructive",
        });
      }
    };
    loadPricing();
  }, [toast]);

  // TIMESTAMP PERSISTENCE: Update config when defaultConfig timestamps change (promo code application)
  useEffect(() => {
    if (defaultConfig?.timestampText && defaultConfig.timestampText !== config.timestampText) {
      console.log('🔄 PricingCalculator: Updating timestamps from defaultConfig:', defaultConfig.timestampText);
      setConfig(prev => ({ ...prev, timestampText: defaultConfig.timestampText || '' }));
    }
  }, [defaultConfig?.timestampText]);

  // Removed watermark functionality - CUTMV is now paid-only with clean exports

  // FORM PERSISTENCE: Save user input to localStorage when form changes
  useEffect(() => {
    if (typeof window !== 'undefined' && config.userEmail) {
      localStorage.setItem('cutmv-user-email', config.userEmail);
    }
  }, [config.userEmail]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('cutmv-generate-gif', config.generateGif.toString());
      localStorage.setItem('cutmv-generate-thumbnails', config.generateThumbnails.toString());
      localStorage.setItem('cutmv-generate-canvas', config.generateCanvas.toString());
    }
  }, [config.generateGif, config.generateThumbnails, config.generateCanvas]);

  // Calculate total amount when config or discount code changes
  useEffect(() => {
    if (!pricing) return;

    const calculateTotal = async () => {
      setIsCalculating(true);
      try {
        // CONDITIONAL PRICING: Only calculate if features are actually enabled
        const hasTimestamps = generateCutdowns && config.timestampText.trim() && countTimestamps(config.timestampText) > 0;
        const hasExports = config.generateGif || config.generateThumbnails || config.generateCanvas;
        
        // PAID-ONLY PRICING: Never show $0.00 - CUTMV is exclusively a paid service
        // If no features selected, don't call pricing API but also don't show free option
        if (!hasTimestamps && !hasExports) {
          console.log('💰 No features selected, maintaining last calculated price or defaulting to minimum');
          // Don't reset to $0 - maintain previous pricing or set minimum
          setIsCalculating(false);
          return;
        }
        
        // All content is now paid - no free options available
        
        const requestData = {
          ...config,
          // Clear aspect ratios if cutdowns not enabled
          aspectRatios: generateCutdowns ? config.aspectRatios : [],
          // Clear timestamp text if cutdowns not enabled  
          timestampText: generateCutdowns ? config.timestampText : '',
          discountCode: discountCode.trim()
        };
        
        // Debug logging to track what's being sent
        console.log('💰 Calculating price with config:', requestData);
        console.log('💰 Selected features:', { 
          generateCutdowns, 
          hasTimestamps, 
          hasExports,
          totalPrice: requestData
        });
        
        const response = await apiRequest("POST", "/api/calculate-price", requestData);
        const data = await response.json();
        
        console.log('💰 Price calculation response:', data);

        // Handle new response format with discount info
        setTotalAmount(data.totalAmount || 0);
        setOriginalAmount((data.totalAmount || 0) + (data.discountApplied || 0));
        setDiscountApplied(data.discountApplied || 0);
        setPromoValidation(data.promoValidation || null);

        // Handle subscriber-aware pricing info
        setIsSubscriber(data.isSubscriber || false);
        setSubscriberCost(data.subscriberCost || 0);
        setPotentialSavings(data.potentialSavings || 0);
        
        // CRITICAL: Re-validate timestamps after promo code application
        if (discountCode.trim() && config.timestampText.trim()) {
          // Ensure timestamps are still valid after discount calculation
          const timestampCount = countTimestamps(config.timestampText);
          if (timestampCount > 0) {
            console.log('Timestamp validation passed after promo code application:', timestampCount, 'timestamps found');
          }
        }
        
      } catch (error) {
        console.error("Failed to calculate price:", error);
        setTotalAmount(0);
        setOriginalAmount(0);
        setDiscountApplied(0);
        setPromoValidation(null);
      } finally {
        setIsCalculating(false);
      }
    };

    calculateTotal();
  }, [config, pricing, discountCode, generateCutdowns]);

  // Handle video upload within this component
  const handleVideoUpload = (video: Video) => {
    console.log('PricingCalculator: Video uploaded in component:', video);
    setLocalUploadedVideo(video);
    
    // Log video upload event to Sentry
    logUserEvent('video_uploaded', {
      fileName: video.originalName,
      duration: video.duration,
      size: video.size || 0,
      hasTimestamps: config.timestampText ? countTimestamps(config.timestampText) : 0
    });

    // Track video upload with PostHog
    trackEngagement('video_uploaded', {
      file_name: video.originalName,
      file_size_mb: Math.round((video.size || 0) / (1024 * 1024)),
      duration_seconds: video.duration,
      upload_method: video.size && video.size > 50 * 1024 * 1024 ? 'chunked' : 'direct'
    });
    
    // RESET PRICING STATE: Clear all toggles and pricing state when new video uploaded
    setGenerateCutdowns(false);
    setConfig(prev => ({
      ...prev,
      timestampText: '',
      aspectRatios: [],
      generateGif: false,
      generateThumbnails: false,
      generateCanvas: false,
      useFullPack: false
    }));
    
    if (onVideoUpload) {
      console.log('PricingCalculator: Calling onVideoUpload callback');
      onVideoUpload(video);
    }
  };

  // Use local video state if available, otherwise use prop
  const currentVideo = localUploadedVideo || uploadedVideo;

  const handlePayment = async () => {
    // Log payment attempt with Sentry (wrapped in try-catch to prevent blocking UI)
    try {
      logPaymentEvent('payment_attempt_started', totalAmount / 100);
      logUserEvent('payment_button_clicked', {
        totalAmount: totalAmount / 100,
        hasTimestamps: config.timestampText ? countTimestamps(config.timestampText) : 0,
        aspectRatios: config.aspectRatios.length,
        generateGif: config.generateGif,
        generateThumbnails: config.generateThumbnails,
        generateCanvas: config.generateCanvas,
        discountApplied: discountApplied / 100
      });

      // Track export selection with PostHog
      trackExportSelection({
        cutdowns: generateCutdowns && config.aspectRatios.length > 0,
        gifs: config.generateGif,
        thumbnails: config.generateThumbnails,
        canvas: config.generateCanvas,
        // Removed watermark tracking - all exports are clean
        totalPrice: totalAmount / 100
      });
    } catch (analyticsError) {
      console.error('Analytics error (non-blocking):', analyticsError);
    }
    
    // Enhanced validation with timestamp preservation check
    const hasTimestamps = config.timestampText && config.timestampText.trim() && countTimestamps(config.timestampText) > 0;
    const hasExports = config.generateGif || config.generateThumbnails || config.generateCanvas;
    
    if (!hasTimestamps && !hasExports) {
      try { logUserEvent('payment_validation_failed', { reason: 'no_options_selected' }); } catch {}
      toast({
        title: "No Options Selected",
        description: "Please select at least one feature to continue",
        variant: "destructive",
      });
      return;
    }

    // Re-validate timestamps after promo code (prevent false negatives)
    if (generateCutdowns && !hasTimestamps) {
      try { logUserEvent('payment_validation_failed', { reason: 'timestamps_required' }); } catch {}
      toast({
        title: "Timestamps Required",
        description: "Please enter timestamps or generate them to create cutdowns",
        variant: "destructive",
      });
      return;
    }
    
    // Email validation
    if (!config.userEmail?.trim()) {
      try { logUserEvent('payment_validation_failed', { reason: 'email_required' }); } catch {}
      toast({
        title: "Email Required",
        description: "Please enter your email address to continue",
        variant: "destructive",
      });
      return;
    }
    
    // Check email verification result
    if (emailVerificationResult && !emailVerificationResult.isValid) {
      try { logUserEvent('payment_validation_failed', { reason: 'email_invalid' }); } catch {}
      toast({
        title: "Invalid Email",
        description: "Please enter a valid email address to continue",
        variant: "destructive",
      });
      return;
    }

    await processPayment();
  };

  const processPayment = async () => {
    setIsCreatingCheckout(true);
    try {
      console.log('💳 Processing with credits/promo, total:', totalAmount, 'discount:', discountApplied, 'code:', discountCode);

      // Call create-payment-session - it handles credit-based processing
      const requestBody = {
        ...config,
        discountCode,
        videoId: uploadedVideo?.id
      };

      console.log('🎫 Sending payment session request:', {
        generateGif: requestBody.generateGif,
        generateThumbnails: requestBody.generateThumbnails,
        generateCanvas: requestBody.generateCanvas,
        generateCutdowns: generateCutdowns,
        timestampText: requestBody.timestampText?.substring(0, 50)
      });

      const response = await apiRequest("POST", "/api/create-payment-session", requestBody);

      // Handle insufficient credits error (402 Payment Required)
      if (response.status === 402) {
        const data = await response.json();
        toast({
          title: "Insufficient Credits",
          description: data.message || `You need ${data.required} credits but only have ${data.available}. Please purchase more credits from your dashboard.`,
          variant: "destructive",
          duration: 8000,
        });
        // Optionally redirect to dashboard to purchase credits
        setTimeout(() => {
          window.location.href = '/dashboard';
        }, 2000);
        return;
      }

      const data = await response.json();

      // Handle credit-based processing success
      if (data.creditBased || data.freeWithPromo) {
        try {
          logPaymentEvent('free_session_created', 0, data.sessionId);
          logUserEvent('promo_code_success', { code: discountCode, sessionId: data.sessionId });
          
          // Track free session creation with PostHog
          trackPayment({
            amount: 0,
            currency: 'USD',  
            paymentMethod: 'promo_code',
            success: true,
            stripeSessionId: data.sessionId
          });
        } catch (analyticsError) {
          console.error('Analytics error (non-blocking):', analyticsError);
        }
        
        toast({
          title: data.creditBased ? "Processing Started!" : "Promo Code Applied!",
          description: data.message || (data.creditBased ? `Using ${data.creditsUsed} credits` : "Processing started for free!"),
          variant: "default",
        });
        
        // Redirect to thank you page for free sessions
        const params = new URLSearchParams();
        if (config.userEmail) params.append('email', config.userEmail);
        if (uploadedVideo?.originalName) params.append('video', uploadedVideo.originalName);
        if (data.sessionId) params.append('sessionId', data.sessionId);
        
        setTimeout(() => {
          window.location.href = `/thank-you?${params.toString()}`;
        }, 2000); // Delay to show success toast
        
        // Use the free session callback instead of payment callback
        if (onFreeSessionCreated) {
          onFreeSessionCreated(data.sessionId, config);
        } else {
          onPaymentRequired(data.sessionId, config);
        }
        return;
      }
      
      // CUTMV is professional-only service - no free content options
      
      if (data.url) {
        try {
          // Track payment initiation with PostHog
          trackPayment({
            amount: totalAmount / 100,
            currency: 'USD',
            paymentMethod: 'stripe_checkout',
            success: false, // Will be updated on completion
            stripeSessionId: data.sessionId
          });
        } catch (analyticsError) {
          console.error('Analytics error (non-blocking):', analyticsError);
        }
        
        // Open Stripe checkout in new tab to preserve current session
        window.open(data.url, '_blank', 'noopener,noreferrer');
        
        // Show user feedback about the new tab
        toast({
          title: "Redirecting to Stripe",
          description: "Payment window opened in new tab. Complete payment there and return here.",
          duration: 5000,
        });
      } else {
        onPaymentRequired(data.sessionId, config);
      }
    } catch (error) {
      toast({
        title: "Payment Error",
        description: "Failed to create payment session. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCreatingCheckout(false);
    }
  };

  const generateRandomTimestamps = () => {
    console.log('Generate timestamps called, currentVideo:', currentVideo);
    console.log('Video properties:', {
      hasDuration: !!currentVideo?.duration,
      duration: currentVideo?.duration,
      hasAspectRatio: !!currentVideo?.aspectRatio,
      aspectRatio: currentVideo?.aspectRatio,
      allKeys: currentVideo ? Object.keys(currentVideo) : []
    });

    if (!currentVideo?.duration) {
      toast({
        title: "Video Required",
        description: "Please upload a video first to generate timestamps.",
        variant: "destructive",
      });
      return;
    }

    // Parse video duration (format: "0:18" or "1:23:45")
    const durationParts = currentVideo.duration.split(':');
    let totalSeconds = 0;
    if (durationParts.length === 2) {
      // MM:SS format
      totalSeconds = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
    } else if (durationParts.length === 3) {
      // HH:MM:SS format
      totalSeconds = parseInt(durationParts[0]) * 3600 + parseInt(durationParts[1]) * 60 + parseInt(durationParts[2]);
    }

    if (totalSeconds < 15) {
      toast({
        title: "Video Too Short",
        description: "Video must be at least 15 seconds to generate cutdowns.",
        variant: "destructive",
      });
      return;
    }

    // Adaptive clip generation based on video length
    let targetClips = 5;
    let minClipDuration = 3;
    let maxClipDuration = 15;

    if (totalSeconds < 30) {
      // Very short video: create 2-3 clips of 3-5 seconds each
      targetClips = Math.max(2, Math.floor(totalSeconds / 8));
      minClipDuration = 3;
      maxClipDuration = Math.min(5, Math.floor(totalSeconds / targetClips) - 1);
    } else if (totalSeconds < 60) {
      // Short video: create 3-4 clips of 5-10 seconds each
      targetClips = Math.max(3, Math.floor(totalSeconds / 15));
      minClipDuration = 5;
      maxClipDuration = Math.min(10, Math.floor(totalSeconds / targetClips) - 1);
    } else if (totalSeconds < 120) {
      // Medium video: create 4-5 clips of 8-15 seconds each
      targetClips = Math.max(4, Math.floor(totalSeconds / 20));
      minClipDuration = 8;
      maxClipDuration = Math.min(15, Math.floor(totalSeconds / targetClips) - 1);
    } else {
      // Long video: create 5 clips of 15-30 seconds each
      targetClips = 5;
      minClipDuration = 15;
      maxClipDuration = 30;
    }

    const ranges = [];
    const usedRanges: Array<{ start: number; end: number }> = [];

    for (let i = 0; i < targetClips; i++) {
      let attempts = 0;
      let validClip = false;

      while (!validClip && attempts < 50) {
        // Random clip duration within range
        const clipDuration = Math.random() * (maxClipDuration - minClipDuration) + minClipDuration;
        
        // Random start time (leave room for clip duration)
        const buffer = Math.min(2, totalSeconds * 0.1);
        const maxStartTime = totalSeconds - clipDuration - buffer;
        const startTime = Math.random() * maxStartTime;
        const endTime = startTime + clipDuration;

        // Check for overlaps with existing clips
        const overlap = usedRanges.some(range => 
          (startTime < range.end && endTime > range.start)
        );

        if (!overlap && endTime <= totalSeconds) {
          usedRanges.push({ start: startTime, end: endTime });

          // Format timestamps
          const startMinutes = Math.floor(startTime / 60);
          const startSecs = Math.floor(startTime % 60);
          const endMinutes = Math.floor(endTime / 60);
          const endSecs = Math.floor(endTime % 60);

          const start = `${startMinutes}:${startSecs.toString().padStart(2, '0')}`;
          const end = `${endMinutes}:${endSecs.toString().padStart(2, '0')}`;

          ranges.push(`${start}-${end}`);
          validClip = true;
        }

        attempts++;
      }
    }

    if (ranges.length === 0) {
      toast({
        title: "Generation Failed",
        description: "Could not generate valid timestamps for this video duration.",
        variant: "destructive",
      });
      return;
    }

    // Sort by start time
    ranges.sort((a, b) => {
      const [aStart] = a.split('-');
      const [bStart] = b.split('-');
      const [aMin, aSec] = aStart.split(':').map(Number);
      const [bMin, bSec] = bStart.split(':').map(Number);
      return (aMin * 60 + aSec) - (bMin * 60 + bSec);
    });

    const timestampText = ranges.join('\n');
    setGeneratedTimestamps(timestampText);
    setConfig({ ...config, timestampText });
    
    // Track timestamp generation with PostHog
    trackEngagement('timestamps_generated', {
      video_duration_seconds: totalSeconds,
      clips_generated: ranges.length,
      min_clip_duration: minClipDuration,
      max_clip_duration: maxClipDuration,
      video_id: currentVideo.id
    });
    
    // TIMESTAMP PERSISTENCE: Save generated timestamps to localStorage
    if (onTimestampTextChange) {
      onTimestampTextChange(timestampText);
    }
    
    // Notify parent component about generated timestamps
    if (onTimestampsGenerated) {
      onTimestampsGenerated(timestampText);
    }

    toast({
      title: "Timestamps Generated",
      description: `Generated ${ranges.length} clips for ${currentVideo.duration} video.`,
    });
  };

  const countTimestamps = (text: string): number => {
    if (!text.trim()) return 0;
    return text.split('\n').filter(line => line.trim() && line.includes('-')).length;
  };

  const formatPrice = (cents: number) => (cents / 100).toFixed(2);
  const formatCredits = (cents: number) => cents; // Credits are 1:1 with cents ($0.99 = 99 credits)

  if (!pricing) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
        </CardContent>
      </Card>
    );
  }

  const hasExports = config.generateGif || config.generateThumbnails || config.generateCanvas;
  const hasAnyFeature = generateCutdowns || hasExports;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Calculator className="text-brand-green mr-2" />
            Select Features & Calculate Price
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <TooltipProvider>
            {/* 1. Upload Video Field */}
            <div className="space-y-3">
              <Label className="text-lg font-medium flex items-center gap-2">
                <Film className="w-5 h-5 text-brand-green" />
                Upload Your Music Video
              </Label>
              {!currentVideo ? (
                <VideoUpload onVideoUpload={handleVideoUpload} uploadedVideo={currentVideo || null} />
              ) : (
                <div className="space-y-3">
                  <div className="p-3 border rounded-lg bg-green-50 border-green-200">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-brand-green rounded-full flex items-center justify-center">
                        <Film className="w-4 h-4 text-white" />
                      </div>
                      <div>
                        <p className="font-medium text-green-800">{currentVideo.originalName}</p>
                        <p className="text-sm text-green-600">Duration: {currentVideo.duration}</p>
                      </div>
                    </div>
                  </div>
                  
                  {/* SHORT VIDEO WARNING - Show for all professional exports */}
                  {currentVideo?.duration && (() => {
                    const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                    const totalSeconds = minutes * 60 + seconds;
                    return totalSeconds < 40 ? (
                      <div className="p-3 border rounded-lg bg-amber-50 border-amber-200">
                        <div className="flex items-start gap-3">
                          <div className="w-6 h-6 bg-amber-500 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                            <span className="text-white text-xs font-bold">!</span>
                          </div>
                          <div className="space-y-2">
                            <p className="font-medium text-amber-800">Short Video Notice</p>
                            <p className="text-sm text-amber-700">
                              Your {currentVideo.duration} video will generate fewer exports due to its short length:
                            </p>
                            <ul className="text-sm text-amber-700 space-y-1 ml-4">
                              <li>• <strong>5 GIFs</strong> instead of 10 (same 199 credits)</li>
                              <li>• <strong>5 thumbnails</strong> instead of 10 (same 199 credits)</li>
                              <li>• <strong>2 Canvas loops</strong> instead of 5 (same 499 credits)</li>
                            </ul>
                            <p className="text-sm text-amber-700 font-medium">
                              For maximum value, consider uploading a video longer than 40 seconds to receive the full quantity of exports.
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : null;
                  })()}
                </div>
              )}
            </div>

            <Separator />

            {/* Video Cutdowns Toggle */}
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 bg-brand-green rounded flex items-center justify-center">
                  <Scissors className="w-3 h-3 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Label className="text-base font-medium">Video Cutdowns</Label>
                    <Tooltip>
                      <TooltipTrigger>
                        <HelpCircle className="w-4 h-4 text-gray-400" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>AI processes each timestamp into one clip. You'll be charged 99 credits per timestamp, per format (vertical and/or horizontal). Selecting both formats = 2x.</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <p className="text-sm text-gray-500">
                    AI cuts sections from your video – 99 credits per timestamp per format
                  </p>
                </div>
              </div>
              <Switch
                checked={generateCutdowns}
                onCheckedChange={(checked) => {
                  setGenerateCutdowns(checked);
                  // PRICING FIX: Clear aspect ratios when cutdowns disabled to prevent phantom pricing
                  if (!checked) {
                    setConfig(prev => ({ ...prev, aspectRatios: [] }));
                  }
                }}
              />
            </div>

            {/* Configure Output Options - Show only when cutdowns enabled */}
            {generateCutdowns && (
              <div className="space-y-4 p-4 border rounded-lg bg-gray-50">
                <div className="flex items-center gap-2 mb-4">
                  <Clock className="w-5 h-5 text-blue-600" />
                  <Label className="text-lg font-medium">Configure Output Options</Label>
                </div>
                
                <TimestampInput
                  videoId={currentVideo?.id}
                  timestampText={config.timestampText}
                  setTimestampText={(text) => {
                    setConfig(prev => ({ ...prev, timestampText: text }));
                    if (onTimestampTextChange) {
                      onTimestampTextChange(text);
                    }
                  }}
                  onTimestampsParsed={(data) => {
                    // Timestamps are parsed internally by TimestampInput
                  }}
                  onGenerateTimestamps={() => {
                    if (currentVideo) {
                      generateRandomTimestamps();
                    }
                  }}
                />
              </div>
            )}

            {/* 3. Format Selection - only show if cutdowns enabled and timestamps exist */}
            {generateCutdowns && config.timestampText.trim() && countTimestamps(config.timestampText) > 0 && (
                  <div className="space-y-3 p-4 border rounded-lg bg-gray-50">
                    <div className="space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <Label className="font-medium">
                          Select Aspect Ratios for {countTimestamps(config.timestampText)} clips:
                        </Label>
                        {/* Smart Default Indicator */}
                        {currentVideo?.aspectRatio && (
                          <Badge variant="outline" className="text-xs self-start">
                            📐 Video is {currentVideo.aspectRatio} - {currentVideo.aspectRatio} suggested
                          </Badge>
                        )}
                      </div>
                      
                      {/* Estimated Clip Count Display */}
                      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                        <p className="text-sm font-medium text-blue-800">
                          You will receive {countTimestamps(config.timestampText) * config.aspectRatios.length} cutdowns 
                          ({countTimestamps(config.timestampText)} timestamps × {config.aspectRatios.length} formats)
                        </p>
                      </div>
                      
                      <div className="grid gap-3">
                        <label className={`p-3 border rounded-lg bg-white hover:bg-gray-50 cursor-pointer ${
                          currentVideo?.aspectRatio === '16:9' ? 'ring-2 ring-blue-200 bg-blue-50' : ''
                        }`}>
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <div className="flex items-center space-x-3">
                              <input
                                type="checkbox"
                                checked={config.aspectRatios.includes('16:9')}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setConfig({ ...config, aspectRatios: [...config.aspectRatios, '16:9'] });
                                  } else {
                                    setConfig({ ...config, aspectRatios: config.aspectRatios.filter(r => r !== '16:9') });
                                  }
                                }}
                                className="rounded"
                              />
                              <span>16:9 (Widescreen)</span>
                            </div>
                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-1 sm:gap-2 ml-7 sm:ml-0">
                              {currentVideo?.aspectRatio === '16:9' && (
                                <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">
                                  Suggested
                                </Badge>
                              )}
                              <Badge variant="secondary">{formatCredits(pricing.cutdown16x9)} credits per clip</Badge>
                            </div>
                          </div>
                        </label>
                        
                        <label className={`p-3 border rounded-lg bg-white hover:bg-gray-50 cursor-pointer ${
                          currentVideo?.aspectRatio === '9:16' ? 'ring-2 ring-purple-200 bg-purple-50' : ''
                        }`}>
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <div className="flex items-center space-x-3">
                              <input
                                type="checkbox"
                                checked={config.aspectRatios.includes('9:16')}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setConfig({ ...config, aspectRatios: [...config.aspectRatios, '9:16'] });
                                  } else {
                                    setConfig({ ...config, aspectRatios: config.aspectRatios.filter(r => r !== '9:16') });
                                  }
                                }}
                                className="rounded"
                              />
                              <span>9:16 (Vertical)</span>
                            </div>
                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-1 sm:gap-2 ml-7 sm:ml-0">
                              {currentVideo?.aspectRatio === '9:16' && (
                                <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-700">
                                  Suggested
                                </Badge>
                              )}
                              <Badge variant="secondary">{formatCredits(pricing.cutdown9x16)} credits per clip</Badge>
                            </div>
                          </div>
                        </label>
                      </div>

                      {/* Fade Effects Options - Only for cutdowns */}
                      <div className="mt-6 p-4 border rounded-lg bg-gradient-to-r from-purple-50 to-pink-50">
                        <div className="flex items-center gap-2 mb-4">
                          <Volume2 className="w-5 h-5 text-purple-600" />
                          <Label className="text-base font-medium">Fade Effects</Label>
                        </div>

                        {/* Video Fade Toggle */}
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <div>
                              <Label className="text-sm font-medium">Video Fade In/Out</Label>
                              <p className="text-xs text-gray-500">Smooth visual transitions</p>
                            </div>
                          </div>
                          <Switch
                            checked={config.videoFade || false}
                            onCheckedChange={(checked) => {
                              setConfig({ ...config, videoFade: checked });
                              localStorage.setItem('cutmv-video-fade', String(checked));
                            }}
                          />
                        </div>

                        {/* Audio Fade Toggle */}
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <div>
                              <Label className="text-sm font-medium">Audio Fade In/Out</Label>
                              <p className="text-xs text-gray-500">Exponential audio curve</p>
                            </div>
                          </div>
                          <Switch
                            checked={config.audioFade || false}
                            onCheckedChange={(checked) => {
                              setConfig({ ...config, audioFade: checked });
                              localStorage.setItem('cutmv-audio-fade', String(checked));
                            }}
                          />
                        </div>

                        {/* Fade Duration - Show when either fade is enabled */}
                        {(config.videoFade || config.audioFade) && (
                          <div className="space-y-2 pl-4 border-l-2 border-purple-300">
                            <Label className="text-sm">Fade Duration</Label>
                            <select
                              value={config.fadeDuration || 0.5}
                              onChange={(e) => {
                                const duration = parseFloat(e.target.value);
                                setConfig({ ...config, fadeDuration: duration });
                                localStorage.setItem('cutmv-fade-duration', String(duration));
                              }}
                              className="w-full px-3 py-2 border rounded-lg bg-white"
                            >
                              <option value="0.3">0.3 seconds (Quick)</option>
                              <option value="0.5">0.5 seconds (Standard)</option>
                              <option value="0.8">0.8 seconds (Smooth)</option>
                              <option value="1.0">1.0 seconds (Cinematic)</option>
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
            )}

            <Separator />

            {/* 4. Additional Export Options */}
            <div className="space-y-4">
              <div>
                <h3 className="font-medium flex items-center gap-2">
                  <FileImage className="w-5 h-5 text-brand-green" />
                  Export Options
                </h3>
                <p className="text-xs text-gray-500 mt-1 italic">
                  * Professional quality exports with no watermarks
                </p>
              </div>

              {/* Upsell for export-only users */}
              {!generateCutdowns && hasExports && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-700">
                    💡 Want full video exports? Add timestamps above to unlock cutdowns.
                  </p>
                </div>
              )}

              <div className="grid gap-3">
                {/* 1. Thumbnails - $1.99 */}
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Image className="w-5 h-5 text-brand-green" />
                    <div>
                      <div className="flex items-center gap-2">
                        <Label className="text-base font-medium">
                          Generate Professional Thumbnails
                        </Label>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="w-4 h-4 text-gray-400" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>
                              AI generates {currentVideo?.duration && (() => {
                                const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                                const totalSeconds = minutes * 60 + seconds;
                                return totalSeconds < 40 ? 'pack of 5' : 'pack of 10';
                              })()} high-quality thumbnail images intelligently spaced throughout your video. Price: {formatCredits(pricing.thumbnailPack)} credits
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="text-sm text-gray-500">
                        {currentVideo?.duration && (() => {
                          const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                          const totalSeconds = minutes * 60 + seconds;
                          return totalSeconds < 40 ? 'Pack of 5 thumbnails' : 'Pack of 10 thumbnails';
                        })()}
                        {` - ${formatCredits(pricing.thumbnailPack)} credits`}
                      </p>
                      <p className="text-xs text-gray-400 italic mt-1">
                        Professional quality with no watermarks
                      </p>
                    </div>
                  </div>
                  <div className="flex-shrink-0 p-2 -m-2">
                    <Switch
                      checked={config.generateThumbnails}
                      onCheckedChange={(checked) => setConfig({ ...config, generateThumbnails: checked })}
                      className="scale-125 touch-manipulation"
                    />
                  </div>
                </div>

                {/* 2. GIFs - $1.99 */}
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <FileImage className="w-5 h-5 text-brand-green" />
                    <div>
                      <div className="flex items-center gap-2">
                        <Label className="text-base font-medium">
                          Generate Professional GIFs
                        </Label>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="w-4 h-4 text-gray-400" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>
                              AI generates {currentVideo?.duration && (() => {
                                const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                                const totalSeconds = minutes * 60 + seconds;
                                return totalSeconds < 40 ? 'pack of 5' : 'pack of 10';
                              })()} smart 6-second GIF clips from your video. Price: {formatCredits(pricing.gifPack)} credits
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="text-sm text-gray-500">
                        {currentVideo?.duration && (() => {
                          const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                          const totalSeconds = minutes * 60 + seconds;
                          return totalSeconds < 40 ? 'Pack of 5 × 6-second GIFs' : 'Pack of 10 × 6-second GIFs';
                        })()}
                        {` - ${formatCredits(pricing.gifPack)} credits`}
                      </p>
                      <p className="text-xs text-gray-400 italic mt-1">
                        Professional quality with no watermarks
                      </p>
                    </div>
                  </div>
                  <div className="flex-shrink-0 p-2 -m-2">
                    <Switch
                      checked={config.generateGif}
                      onCheckedChange={(checked) => setConfig({ ...config, generateGif: checked })}
                      className="scale-125 touch-manipulation"
                    />
                  </div>
                </div>

                {/* 3. Spotify Canvas - $4.99 (Most expensive) */}
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 bg-black rounded-full flex items-center justify-center">
                      <SiSpotify className="w-3 h-3 text-brand-green" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <Label className="text-base font-medium">
                          Generate Professional Spotify Canvas
                        </Label>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="w-4 h-4 text-gray-400" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="space-y-2">
                              <p>
                                AI generates {currentVideo?.duration && (() => {
                                  const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                                  const totalSeconds = minutes * 60 + seconds;
                                  return totalSeconds < 40 ? 'pack of 2' : 'pack of 5';
                                })()} vertical 1080x1920 8-second loops optimized for Spotify Canvas. Price: {formatCredits(pricing.spotifyCanvas)} credits
                              </p>
                              <a 
                                href="https://artists.spotify.com/canvas" 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-blue-600 hover:text-blue-800 text-sm"
                              >
                                View Spotify Canvas Guidelines <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="text-sm text-gray-500">
                        {currentVideo?.duration && (() => {
                          const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                          const totalSeconds = minutes * 60 + seconds;
                          return totalSeconds < 40 ? 'Pack of 2 × 8-second Canvas' : 'Pack of 5 × 8-second Canvas';
                        })()}
                        {` - ${formatCredits(pricing.spotifyCanvas)} credits`}
                      </p>
                      <p className="text-xs text-gray-400 italic mt-1">
                        Professional quality exports ready for commercial use
                      </p>
                    </div>
                  </div>
                  <div className="flex-shrink-0 p-2 -m-2">
                    <Switch
                      checked={config.generateCanvas}
                      onCheckedChange={(checked) => setConfig({ ...config, generateCanvas: checked })}
                      className="scale-125 touch-manipulation"
                    />
                  </div>
                </div>

                {/* Professional Service Notice */}
                {currentVideo && (
                  <div className="p-4 border-2 border-green-200 rounded-lg bg-green-50">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Label className="text-base font-medium text-green-800">Professional Quality Exports</Label>
                        </div>
                        <p className="text-sm text-green-700 mt-1">
                          All content is delivered clean and watermark-free, ready for professional use.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* 5. Bundle Option - Always show when any export option exists */}
                {hasExports && (
                  <div className="mt-6 p-4 bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-400 rounded-lg shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <Label className="text-lg font-bold text-green-900">💎 Bundle All Add-ons</Label>
                          <Tooltip>
                            <TooltipTrigger>
                              <HelpCircle className="w-4 h-4 text-green-600" />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Get all three export types (GIFs, Thumbnails, and Canvas) bundled together for maximum value. Save {formatCredits(pricing.gifPack + pricing.thumbnailPack + pricing.spotifyCanvas - pricing.fullFeaturePack)} credits!</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>

                        {/* Savings Calculation */}
                        <div className="mt-2 space-y-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-bold text-green-900">{formatCredits(pricing.fullFeaturePack)} credits</span>
                            <span className="text-sm text-gray-500 line-through">{formatCredits(pricing.gifPack + pricing.thumbnailPack + pricing.spotifyCanvas)} credits</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-green-600 text-white">
                              Save {formatCredits(pricing.gifPack + pricing.thumbnailPack + pricing.spotifyCanvas - pricing.fullFeaturePack)} credits (36%)
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex-shrink-0 p-2 -m-2">
                        <Switch
                          checked={config.useFullPack}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setConfig({
                                ...config,
                                useFullPack: true,
                                generateGif: true,
                                generateThumbnails: true,
                                generateCanvas: true
                              });
                            } else {
                              setConfig({ ...config, useFullPack: false });
                            }
                          }}
                          className="scale-125 touch-manipulation"
                        />
                      </div>
                    </div>

                    {/* Pricing Comparison Table */}
                    <details className="mt-3 group">
                      <summary className="cursor-pointer text-sm text-green-800 font-medium hover:text-green-900 flex items-center gap-1">
                        <span className="transform transition-transform group-open:rotate-90">▶</span>
                        Compare pricing options
                      </summary>
                      <div className="mt-3 bg-white rounded-lg p-3 border border-green-200">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200">
                              <th className="text-left py-2 font-semibold text-gray-700">Option</th>
                              <th className="text-right py-2 font-semibold text-gray-700">Price</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            <tr>
                              <td className="py-2 text-gray-600">GIF Pack (10 clips)</td>
                              <td className="py-2 text-right font-medium">{formatCredits(pricing.gifPack)}</td>
                            </tr>
                            <tr>
                              <td className="py-2 text-gray-600">Thumbnail Pack (10 images)</td>
                              <td className="py-2 text-right font-medium">{formatCredits(pricing.thumbnailPack)}</td>
                            </tr>
                            <tr>
                              <td className="py-2 text-gray-600">Canvas Pack (5 loops)</td>
                              <td className="py-2 text-right font-medium">{formatCredits(pricing.spotifyCanvas)}</td>
                            </tr>
                            <tr className="font-semibold text-gray-500">
                              <td className="py-2 border-t-2 border-gray-300">Total if bought separately</td>
                              <td className="py-2 text-right border-t-2 border-gray-300 line-through">{formatCredits(pricing.gifPack + pricing.thumbnailPack + pricing.spotifyCanvas)}</td>
                            </tr>
                            <tr className="font-bold text-green-900 bg-green-50">
                              <td className="py-2 border-t-2 border-green-400">💎 Bundle Price</td>
                              <td className="py-2 text-right border-t-2 border-green-400 text-lg">{formatCredits(pricing.fullFeaturePack)}</td>
                            </tr>
                            <tr className="font-semibold text-green-700">
                              <td className="py-2">You Save</td>
                              <td className="py-2 text-right">{formatCredits(pricing.gifPack + pricing.thumbnailPack + pricing.spotifyCanvas - pricing.fullFeaturePack)} (36%)</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </div>
                )}
              </div>
            </div>
          </TooltipProvider>
        </CardContent>
      </Card>

      {/* 6. Price Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Price Summary</span>
            <div className="flex items-center gap-2">
              {hasAnyFeature && totalAmount > 0 && !discountCode.trim() && (
                <span className="text-xs text-gray-500 bg-yellow-50 px-2 py-1 rounded-full border border-yellow-200">
                  💡 Promo codes available below
                </span>
              )}
              {isCalculating && <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {/* Show pricing breakdown only when features are enabled */}
            {generateCutdowns && countTimestamps(config.timestampText) > 0 && config.aspectRatios.length > 0 && (
              <div className="flex justify-between">
                <span>Video Cutdowns ({countTimestamps(config.timestampText)} × {config.aspectRatios.length} formats)</span>
                <span>
                  {formatCredits(countTimestamps(config.timestampText) * config.aspectRatios.length * pricing.cutdown16x9)} credits
                </span>
              </div>
            )}

            {hasExports && !config.useFullPack && (
              <>
                {config.generateGif && (
                  <div className="flex justify-between">
                    <span>GIF Pack ({currentVideo?.duration && (() => {
                      const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                      const totalSeconds = minutes * 60 + seconds;
                      return totalSeconds < 40 ? '5' : '10';
                    })()} × 6-second clips)</span>
                    <span>{formatCredits(pricing.gifPack)} credits</span>
                  </div>
                )}
                {config.generateThumbnails && (
                  <div className="flex justify-between">
                    <span>Thumbnail Pack ({currentVideo?.duration && (() => {
                      const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                      const totalSeconds = minutes * 60 + seconds;
                      return totalSeconds < 40 ? '5' : '10';
                    })()} high-quality stills)</span>
                    <span>{formatCredits(pricing.thumbnailPack)} credits</span>
                  </div>
                )}
                {config.generateCanvas && (
                  <div className="flex justify-between">
                    <span>Spotify Canvas Pack ({currentVideo?.duration && (() => {
                      const [minutes, seconds] = currentVideo.duration.split(':').map(Number);
                      const totalSeconds = minutes * 60 + seconds;
                      return totalSeconds < 40 ? '2' : '5';
                    })()} × 8-second loops)</span>
                    <span>{formatCredits(pricing.spotifyCanvas)} credits</span>
                  </div>
                )}
              </>
            )}

            {config.useFullPack && hasExports && (
              <div className="flex justify-between">
                <span>Full Feature Pack (GIFs + Thumbnails + Canvas)</span>
                <span>{formatCredits(pricing.fullFeaturePack)} credits</span>
              </div>
            )}



            {/* Show discount if applied */}
            {discountApplied > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Discount ({promoValidation?.code || 'Promo Code'})</span>
                <span>-{formatCredits(discountApplied)} credits</span>
              </div>
            )}

            <Separator />

            {/* Show original total if discount applied */}
            {discountApplied > 0 && (
              <div className="flex justify-between text-sm text-gray-500 line-through">
                <span>Original Total</span>
                <span>{formatCredits(originalAmount)} credits</span>
              </div>
            )}

            <div className="flex justify-between text-lg font-semibold">
              <span>Total</span>
              <span className={discountApplied > 0 && totalAmount === 0 ? "text-green-600" : ""}>
                {totalAmount === 0 && discountApplied > 0 ? "FREE" :
                 totalAmount === 0 ? "Select features above" :
                 `${formatCredits(totalAmount)} credits`}
              </span>
            </div>
            
            {/* EXPORT QUALITY MESSAGING */}
            {hasExports && (
              <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-800 font-medium">
                  All exports are professional-grade, clean files ready for immediate use across platforms.
                </p>
              </div>
            )}
          </div>



          {/* Promo Code Toggle Button */}
          {hasAnyFeature && totalAmount > 0 && !showPromoInput && !discountCode.trim() && (
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowPromoInput(true)}
                className="text-sm"
              >
                🎫 Have a promo code?
              </Button>
            </div>
          )}

          {/* Promo Code Input Section - Visible when toggled or when user has entered code */}
          {hasAnyFeature && totalAmount > 0 && (showPromoInput || discountCode.trim()) && (
            <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-gray-50">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🎫</span>
                  <Label htmlFor="discount-code" className="text-sm font-medium text-gray-900">
                    Promo Code
                  </Label>
                </div>
                {!discountCode.trim() && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowPromoInput(false)}
                    className="text-xs text-gray-500 hover:text-gray-700 px-2"
                  >
                    Hide
                  </Button>
                )}
              </div>
              <div className="relative">
                <Input
                  id="discount-code"
                  type="text"
                  placeholder="Enter your promo code"
                  value={discountCode}
                  onChange={(e) => setDiscountCode(e.target.value)}
                  className={`text-sm pr-10 ${
                    promoValidation?.isValid ? 'border-green-500 bg-green-50' : 
                    promoValidation?.isValid === false && discountCode.trim() ? 'border-red-500 bg-red-50' : 'bg-white'
                  }`}
                />
                {discountCode.trim() && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDiscountCode('');
                      setPromoValidation(null);
                      setDiscountApplied(0);
                      setOriginalAmount(totalAmount + discountApplied);
                      setShowPromoInput(false);
                      toast({
                        title: "Promo code removed",
                        description: "You can now enter a different promo code."
                      });
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 p-0 hover:bg-gray-200"
                    title="Remove promo code"
                  >
                    <X className="h-4 w-4 text-gray-500" />
                  </Button>
                )}
              </div>
              
              {/* Promo code validation feedback */}
              {promoValidation && discountCode.trim() && (
                <div className={`text-sm mt-2 font-medium ${promoValidation.isValid ? 'text-green-600' : 'text-red-600'}`}>
                  {promoValidation.message}
                </div>
              )}
            </div>
          )}

          {/* Subscription upsell for non-subscribers */}
          {hasAnyFeature && !isSubscriber && potentialSavings > 0 && (
            <div className="mt-4 p-4 bg-gradient-to-r from-brand-green/10 to-green-50 border border-brand-green/30 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-brand-green">Save 50% with a Subscription!</p>
                  <p className="text-sm text-gray-600 mt-1">
                    Subscribers pay only <span className="font-bold">{formatCredits(subscriberCost)} credits</span> for this export
                    <span className="text-brand-green ml-1">(saving {formatCredits(potentialSavings)} credits)</span>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-brand-green text-brand-green hover:bg-brand-green hover:text-white"
                  onClick={() => window.location.href = '/dashboard?tab=subscription'}
                >
                  Subscribe
                </Button>
              </div>
            </div>
          )}

          {/* Subscriber badge */}
          {hasAnyFeature && isSubscriber && (
            <div className="mt-4 p-3 bg-brand-green/10 border border-brand-green/30 rounded-lg">
              <div className="flex items-center gap-2">
                <Badge className="bg-brand-green text-white">Subscriber</Badge>
                <span className="text-sm text-brand-green font-medium">You're saving 50% on this export!</span>
              </div>
            </div>
          )}

          {hasAnyFeature && (
            <Button
              onClick={handlePayment}
              disabled={
                isCreatingCheckout ||
                !hasAnyFeature ||
                !config.userEmail?.trim() ||
                (totalAmount === 0 && discountApplied === 0)
              }
              className="w-full mt-4"
              size="lg"
            >
              <CreditCard className="w-4 h-4 mr-2" />
              {isCreatingCheckout ? "Creating Session..." :
               totalAmount === 0 && discountApplied > 0 ? "Start Free Generation" :
               totalAmount === 0 ? "Select Features to Continue" :
               `Process with ${formatCredits(totalAmount)} Credits`}
            </Button>
          )}

          {/* Payment flow explanation for users */}
          {hasAnyFeature && totalAmount > 0 && (
            <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start gap-2">
                <div className="w-4 h-4 bg-blue-500 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center">
                  <span className="text-white text-xs font-bold">i</span>
                </div>
                <div className="text-sm text-blue-800">
                  <p className="font-medium">Payment opens in a new tab</p>
                  <p className="text-blue-700 mt-1">Complete your payment in the new tab, then return here. Your video upload will be preserved.</p>
                </div>
              </div>
            </div>
          )}

          {!hasAnyFeature && (
            <div className="mt-4 p-4 border border-amber-200 rounded-lg bg-amber-50">
              <div className="text-center">
                <p className="text-amber-800 font-medium mb-2">Ready to Create Export?</p>
                <p className="text-amber-700 text-sm mb-3">Follow these steps:</p>
                <div className="text-left space-y-2 text-sm text-amber-700">
                  <div className="flex items-center gap-2">
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-xs font-bold ${currentVideo ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-600'}`}>
                      {currentVideo ? '✓' : '1'}
                    </div>
                    <span className={currentVideo ? 'text-green-700 font-medium' : ''}>
                      Upload your video {currentVideo ? '✓ Complete' : '(required)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-xs font-bold ${hasAnyFeature ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-600'}`}>
                      {hasAnyFeature ? '✓' : '2'}
                    </div>
                    <span className={hasAnyFeature ? 'text-green-700 font-medium' : ''}>
                      Select export features below {hasAnyFeature ? '✓ Complete' : '(required)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-xs font-bold ${config.userEmail?.trim() ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-600'}`}>
                      {config.userEmail?.trim() ? '✓' : '3'}
                    </div>
                    <span className={config.userEmail?.trim() ? 'text-green-700 font-medium' : ''}>
                      Enter your email {config.userEmail?.trim() ? '✓ Complete' : '(required)'}
                    </span>
                  </div>
                </div>
                {currentVideo && (
                  <p className="text-amber-600 text-xs mt-3 font-medium">
                    👇 Select your export options below to continue
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Selection Summary at Bottom - Professional service only */}
          {false && (
            <div className="mt-6 flex justify-center">
              <div className="inline-flex items-center gap-3 px-6 py-3 bg-white border-2 border-brand-green rounded-full shadow-sm">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-brand-green rounded-full"></div>
                  <span className="text-sm font-medium text-gray-700">
                    You selected: <span className="text-brand-green font-semibold">
                      Professional Quality Exports
                    </span>
                  </span>
                </div>
                <button 
                  onClick={() => {
                    const choiceSection = document.querySelector('[data-section="quality-choice"]');
                    choiceSection?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="text-xs text-gray-500 hover:text-brand-green transition-colors underline"
                >
                  Change
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}