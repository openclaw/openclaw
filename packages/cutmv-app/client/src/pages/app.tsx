/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState, useEffect } from "react";
import { Scissors, Upload, Clock, Download, FileImage, Image, Calculator } from "lucide-react";
import VideoUpload from "@/components/VideoUpload";


import TimestampInput from "@/components/TimestampInput";
import TimestampPreview from "@/components/TimestampPreview";
import ProcessingControls from "@/components/ProcessingControls";
import PricingCalculator from "@/components/PricingCalculator";
import PaymentSuccess from "@/components/PaymentSuccess";
import FeedbackButton from "@/components/FeedbackButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Video, Timestamp } from "@shared/schema";
import fdLogo from "@/assets/fd-logo.png";
import { trackPageView, trackEngagement } from '@/lib/posthog';
import EmailCapture from "@/components/EmailCapture";
import { ReferralTracker } from '@/components/referral/ReferralTracker';
import { AuthGuard, useAuth } from "@/components/AuthGuard";
import DashboardLayout from "@/components/DashboardLayout";
import FaviconProvider from "@/components/FaviconProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useAuthCheck } from "@/hooks/useAuthCheck";

interface PaymentSession {
  sessionId: string;
  timestampCount: number;
  aspectRatios: ('16:9' | '9:16')[];
  generateGif: boolean;
  generateThumbnails: boolean;
  generateCanvas: boolean;
  totalAmount: number;
  paid: boolean;
  // Removed watermark functionality - all exports are clean
}

export default function AppPage() {
  const { user } = useAuth();
  const [uploadedVideo, setUploadedVideo] = useState<Video | null>(null);
  const [timestamps, setTimestamps] = useState<Timestamp[]>([]);
  
  // Silent authentication monitoring
  useAuthCheck();

  // Track page view on component mount (with delay to ensure PostHog is loaded)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        trackPageView('app', {
          user_email: user?.email || 'anonymous'
        });
      } catch (error) {
        // Silently ignore PostHog tracking errors
        console.debug('PostHog tracking not available on page load');
      }
    }, 500);
    
    return () => clearTimeout(timer);
  }, [user]);  
  
  // TIMESTAMP PERSISTENCE: Initialize from localStorage to survive page refreshes
  const [timestampText, setTimestampText] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('cutmv-timestamp-text') || "";
    }
    return "";
  });
  
  // Removed errors and warnings state - now handled internally by TimestampInput
  
  // State for active section tracking
  const [activeStep, setActiveStep] = useState<'upload' | 'timestamp' | 'pricing' | 'processing'>('upload');
  
  // Cutdowns state - controls whether timestamp input is shown
  const [generateCutdowns, setGenerateCutdowns] = useState(false);
  
  // PAYMENT SESSION: Track the current payment/processing session
  const [paymentSession, setPaymentSession] = useState<PaymentSession | null>(null);
  
  // Reference to the timestamp generation function from PricingCalculator
  const [generateTimestampsFunction, setGenerateTimestampsFunction] = useState<(() => void) | null>(null);

  // Check for encrypted reuse token on mount to pre-populate existing video
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const reuseToken = urlParams.get('reuse');
    
    // Check for encrypted reuse token
    if (reuseToken && !uploadedVideo) {
      console.log('🔄 Encrypted reuse token found, decrypting...');
      
      // Decrypt via API to get video ID
      fetch('/api/decrypt-reuse-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: reuseToken })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.videoId) {
          console.log('🔄 Loading video from decrypted token');
          fetchVideoForReuse(data.videoId);
        }
      })
      .catch(err => console.error('Failed to decrypt reuse token:', err));
      
      return;
    }
    
    // Check for localStorage reselected upload from dashboard
    const reselectedUploadData = localStorage.getItem('reselectedUpload');
    if (reselectedUploadData && !uploadedVideo) {
      try {
        const uploadData = JSON.parse(reselectedUploadData);
        console.log('🔄 Reselected upload found in localStorage:', uploadData);
        
        // Create video object from stored data with all required properties
        const videoFromUpload = {
          id: uploadData.videoId,
          originalName: uploadData.filename,
          filename: uploadData.filename,
          path: '', // Path not needed for re-export
          r2Key: null, // Will be populated when needed
          r2Url: null, // Will be populated when needed
          size: uploadData.size,
          duration: uploadData.duration,
          width: null,
          height: null,
          format: null,
          codec: null,
          bitrate: null,
          frameRate: null,
          uploadedAt: new Date(),
          expiresAt: null,
          status: 'active' as const,
          aspectRatio: null,
          userEmail: null,
          sessionId: null,
          processed: false,
          timestampsGenerated: false,
          videoTitle: null,
          artistInfo: null
        };
        
        setUploadedVideo(videoFromUpload);
        
        // Clear the localStorage data after using it
        localStorage.removeItem('reselectedUpload');
        
        console.log('✅ Video pre-loaded from dashboard selection:', videoFromUpload);
      } catch (error) {
        console.error('❌ Error parsing reselected upload data:', error);
        localStorage.removeItem('reselectedUpload');
      }
    }
  }, [uploadedVideo]);

  // Function to fetch and pre-populate video for re-export
  const fetchVideoForReuse = async (videoId: number) => {
    try {
      const response = await fetch(`/api/user/videos/${videoId}`, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const videoData = await response.json();
        console.log('📼 Video loaded for reuse:', videoData);
        setUploadedVideo(videoData.video);
        setActiveStep('pricing'); // Go directly to pricing for re-export
      } else {
        console.error('❌ Failed to load video for reuse:', response.status);
      }
    } catch (error) {
      console.error('❌ Error loading video for reuse:', error);
    }
  };

  // Clear session state when video changes
  useEffect(() => {
    console.log('AppPage: uploadedVideo effect triggered:', uploadedVideo);
    try {
      if (uploadedVideo) {
        console.log('AppPage: Video uploaded, clearing session state and going to pricing');
        setPaymentSession(null);
        setActiveStep('pricing'); // Go directly to pricing where cutdowns toggle is
        // Clear any previous timestamps when a new video is uploaded (but not when reusing)
        const urlParams = new URLSearchParams(window.location.search);
        const reuseVideoId = urlParams.get('reuse');
        if (!reuseVideoId) {
          setTimestampText("");
          setTimestamps([]);
          setGenerateCutdowns(false); // Reset cutdowns toggle
          // Clear localStorage so old timestamps don't persist
          localStorage.removeItem('cutmv-timestamp-text');
        }
        console.log('AppPage: Session state cleared successfully');
      } else {
        console.log('AppPage: No video, resetting to upload step');
        // Reset to upload step if no video
        setActiveStep('upload');
      }
    } catch (error) {
      console.error('AppPage: Error in uploadedVideo useEffect:', error);
    }
  }, [uploadedVideo]);

  // Auto-advance step based on cutdowns and timestamps
  useEffect(() => {
    if (uploadedVideo && generateCutdowns && timestampText.trim()) {
      setActiveStep('timestamp');
    } else if (uploadedVideo) {
      setActiveStep('pricing');
    }
  }, [uploadedVideo, generateCutdowns, timestampText]);

  // Clear timestamps when cutdowns is disabled
  useEffect(() => {
    if (!generateCutdowns) {
      setTimestampText("");
      setTimestamps([]);
      localStorage.removeItem('cutmv-timestamp-text');
    }
  }, [generateCutdowns]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
      window.location.href = '/';
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <AuthGuard>
      <ErrorBoundary>
        <ReferralTracker />
        <FaviconProvider 
          title="Video Processing Tool - CUTMV | Full Digital"
          description="Transform your music videos into multiple formats with AI-powered processing. Create professional cutdowns, GIFs, thumbnails, and Spotify Canvas."
        >
          <DashboardLayout currentUser={user} onLogout={handleLogout}>
          <TooltipProvider>
            <div className="p-6">
              <div className="max-w-4xl mx-auto">
            {!paymentSession ? (
              <div className="space-y-8">
                {/* Hero Section */}
                <div className="text-center mb-12">
                  <div className="flex items-center justify-center gap-3 mb-6">
                    <div className="p-3 rounded-2xl shadow-lg bg-black">
                      <img src={fdLogo} alt="Full Digital" className="w-8 h-8" />
                    </div>
                    <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 bg-clip-text text-transparent">
                      CUTMV
                    </h1>
                  </div>
                  <p className="text-xl text-gray-600 max-w-2xl mx-auto">
                    Welcome back, {user?.name || user?.email}! Transform your video into multiple formats with AI-powered processing.
                  </p>
                </div>

                {/* Progress Steps - Mobile Responsive */}
                <div className="flex justify-center mb-12 px-4">
                  <div className="flex items-center space-x-2 sm:space-x-4 bg-white rounded-full px-3 sm:px-6 py-3 shadow-md border overflow-x-auto min-w-0">
                    {[
                      { id: 'upload', label: 'Upload', icon: Upload },
                      { id: 'timestamp', label: 'Configure', icon: Clock },
                      { id: 'pricing', label: 'Price', icon: Calculator },
                      { id: 'processing', label: 'Process', icon: Download }
                    ].map((step, index) => {
                      const Icon = step.icon;
                      const isActive = activeStep === step.id;
                      const isCompleted = 
                        (step.id === 'upload' && uploadedVideo) ||
                        (step.id === 'timestamp' && timestampText.trim()) ||
                        (step.id === 'pricing' && paymentSession);
                      
                      return (
                        <div key={step.id} className="flex items-center flex-shrink-0">
                          <div className={`flex items-center space-x-1 sm:space-x-2 px-2 sm:px-3 py-2 rounded-full transition-all ${
                            isActive ? 'text-white' : 
                            isCompleted ? 'bg-gray-100 text-gray-600' : 
                            'text-gray-400'
                          }`} style={isActive ? { backgroundColor: 'hsl(85, 70%, 55%)' } : {}}>
                            <Icon className="w-4 h-4 flex-shrink-0" />
                            <span className="text-xs sm:text-sm font-medium whitespace-nowrap">{step.label}</span>
                          </div>
                          {index < 3 && (
                            <div className={`w-4 sm:w-8 h-0.5 mx-1 sm:mx-2 flex-shrink-0 ${
                              isCompleted ? 'bg-gray-200' : 'bg-gray-200'
                            }`} style={isCompleted ? { backgroundColor: 'hsl(85, 70%, 55%)' } : {}} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Main Content - Centered */}
                <div className="max-w-4xl mx-auto space-y-8">
                  {/* Video Upload & Processing - Centered */}
                  <div className="space-y-6">
                    {/* Step 1: Video Upload */}
                    <Card className={`transition-all duration-300 ${activeStep === 'upload' ? 'ring-2 ring-green-200 shadow-lg' : ''}`}>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Upload className="w-5 h-5" style={{ color: 'hsl(85, 70%, 55%)' }} />
                          Upload Your Video
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <VideoUpload 
                          uploadedVideo={uploadedVideo}
                          onVideoUpload={(video) => {
                            console.log('AppPage: Received video upload callback:', video);
                            try {
                              setUploadedVideo(video);
                              console.log('AppPage: Video state updated successfully');
                            } catch (error) {
                              console.error('AppPage: Failed to update video state:', error);
                            }
                          }} 
                        />
                      </CardContent>
                    </Card>


                  </div>

                  {/* Pricing Section - Always show after upload */}
                  {uploadedVideo && (
                    <Card className={`transition-all duration-300 ${activeStep === 'pricing' ? 'ring-2 ring-green-200 shadow-lg' : ''}`}>
                      <CardContent>
                        <PricingCalculator
                          uploadedVideo={uploadedVideo}
                          generateCutdowns={generateCutdowns}
                          setGenerateCutdowns={setGenerateCutdowns}
                          onPaymentRequired={(sessionId, paymentConfig) => {
                            setPaymentSession({
                              sessionId,
                              timestampCount: paymentConfig.timestampText ? paymentConfig.timestampText.split('\n').filter(line => line.trim() && line.includes('-')).length : 0,
                              aspectRatios: paymentConfig.aspectRatios,
                              generateGif: paymentConfig.generateGif,
                              generateThumbnails: paymentConfig.generateThumbnails, 
                              generateCanvas: paymentConfig.generateCanvas,
                              totalAmount: 0, // Will be updated by payment flow
                              paid: false
                            });
                            setActiveStep('processing');
                          }}
                          onTimestampTextChange={setTimestampText}
                          onTimestampsGenerated={(generatedText) => {
                            setTimestampText(generatedText);
                            // Parse the generated timestamps
                            const timestampLines = generatedText.split('\n');
                            const parsedTimestamps = timestampLines
                              .filter(line => line.trim() && line.includes('-'))
                              .map((line, index) => {
                                const [start, end] = line.split('-').map(s => s.trim());
                                return { id: index + 1, startTime: start, endTime: end };
                              });
                            setTimestamps(parsedTimestamps);
                          }}
                          onRegisterGenerateFunction={(generateFn) => {
                            setGenerateTimestampsFunction(() => generateFn);
                          }}
                          defaultConfig={{
                            timestampText,
                          }}
                        />
                      </CardContent>
                    </Card>
                  )}
                </div>
              </div>
            ) : (
              /* Payment Success / Processing View */
              <div className="max-w-4xl mx-auto">
                <PaymentSuccess 
                  sessionId=""
                  onPaymentVerified={() => {}}
                  onError={() => {}}
                />
              </div>
            )}
              </div>
            </div>
          </TooltipProvider>
          </DashboardLayout>
        </FaviconProvider>
      </ErrorBoundary>
    </AuthGuard>
  );
}