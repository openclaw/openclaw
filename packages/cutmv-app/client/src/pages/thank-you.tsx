/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { Link, useLocation } from "wouter";
import { ArrowLeft, Clock, Mail, CheckCircle, Loader2, Download, BarChart3, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useWebSocketProgress } from "@/hooks/useWebSocketProgress";
import { useState, useEffect } from "react";
import fdLogo from "@/assets/fd-logo.png";
import { useAuth } from "@/components/AuthGuard";

export default function ThankYou() {
  const [, setLocation] = useLocation();
  const { user } = useAuth(); // Get authenticated user
  const [videoId, setVideoId] = useState<number | null>(null);
  const [isCompleted, setIsCompleted] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [canBulkDownload, setCanBulkDownload] = useState(false);
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);

  // Get encrypted session token from URL (no sensitive data exposed)
  const params = new URLSearchParams(location.search);
  const sessionToken = params.get('session') || '';

  // Decrypt session data on client side via API
  const [sessionData, setSessionData] = useState<{
    email: string;
    sessionId: string;
    videoName: string;
  }>({ email: '', sessionId: '', videoName: 'your video' });
  
  useEffect(() => {
    if (sessionToken) {
      // Decrypt session data via API
      fetch('/api/decrypt-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sessionToken })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setSessionData({
            email: data.email,
            sessionId: data.sessionId,
            videoName: data.videoName || 'your video'
          });
        }
      })
      .catch(err => console.error('Failed to decrypt session:', err));
    }
  }, [sessionToken]);
  
  const { email: userEmail, sessionId, videoName } = sessionData;
  
  // Progress tracking for processing completion
  const { 
    progressData, 
    isConnected
  } = useWebSocketProgress({
    videoId: videoId,
    onProgress: (data) => {
      console.log('📊 Progress update:', data.progress + '%', data.currentOperation);
    },
    onComplete: (data) => {
      console.log('✅ Processing completed!', data);
      setIsCompleted(true);
      if (data.downloadPath) {
        setDownloadUrl(data.downloadPath);
      }
    },
    onError: (errors) => {
      console.error('❌ Processing failed:', errors);
    }
  });

  // Get video ID from session storage or API
  useEffect(() => {
    const checkForVideoId = async () => {
      // First try to get from sessionStorage
      const storedVideoId = sessionStorage.getItem('currentVideoId');
      if (storedVideoId) {
        setVideoId(parseInt(storedVideoId));
        return;
      }
      
      // If we have a session ID, try to get video ID from it
      if (sessionId) {
        try {
          const response = await fetch(`/api/session-status/${sessionId}`);
          if (response.ok) {
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              const data = await response.json();
              if (data.videoId) {
                setVideoId(data.videoId);
                sessionStorage.setItem('currentVideoId', data.videoId.toString());
              }
            } else {
              console.log('Session status endpoint returned non-JSON response');
            }
          } else {
            console.log('Session status not found for ID:', sessionId);
          }
        } catch (error) {
          console.log('Could not get video ID from session:', error);
        }
      }
    };

    checkForVideoId();
  }, [sessionId]);

  // Monitor progress completion - now handled directly by onComplete callback
  useEffect(() => {
    if (progressData?.status === 'completed') {
      setIsCompleted(true);
      if (progressData.downloadPath) {
        setDownloadUrl(progressData.downloadPath);
      }
    }
  }, [progressData]);

  // AUTO-REFRESH: Poll for completion status every 5 seconds as fallback if WebSocket disconnects
  useEffect(() => {
    if (isCompleted || !sessionId) return; // Stop polling if already completed or no session

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/job-status/${sessionId}`, {
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();

          // Check if job is completed
          if (data.status === 'completed') {
            console.log('✅ Job completed! Auto-updating status...');
            setIsCompleted(true);

            if (data.downloadUrl) {
              setDownloadUrl(data.downloadUrl);
            }

            // Clear interval once completed
            clearInterval(pollInterval);
          }
        }
      } catch (error) {
        console.error('Status polling error:', error);
        // Continue polling even if error occurs
      }
    }, 5000); // Poll every 5 seconds

    // Cleanup interval on unmount
    return () => clearInterval(pollInterval);
  }, [sessionId, isCompleted]);

  // Check if user can bulk download (Pro+ feature)
  useEffect(() => {
    const checkBulkDownload = async () => {
      try {
        const response = await fetch('/api/can-bulk-download', {
          credentials: 'include'
        });
        if (response.ok) {
          const data = await response.json();
          setCanBulkDownload(data.canBulkDownload);
        }
      } catch (error) {
        console.log('Could not check bulk download permission');
      }
    };

    if (user) {
      checkBulkDownload();
    }
  }, [user]);

  // Handle bulk ZIP download
  const handleBulkDownload = async () => {
    if (!sessionId) return;

    setIsDownloadingZip(true);
    try {
      const response = await fetch(`/api/bulk-download/${sessionId}`, {
        credentials: 'include'
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cutmv_exports_${sessionId}.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      } else {
        console.error('Bulk download failed');
      }
    } catch (error) {
      console.error('Bulk download error:', error);
    } finally {
      setIsDownloadingZip(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-brand-black border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <Link href="/">
              <Button variant="ghost" className="text-white hover:text-brand-green">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to CUTMV
              </Button>
            </Link>
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-white mr-4">CUTMV</h1>
              <span className="text-xs bg-brand-green text-black px-2 py-1 rounded-full font-bold mr-4">BETA</span>
              <img src={fdLogo} alt="Full Digital" className="h-8 w-8" />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <Card className="bg-white dark:bg-gray-900 border-2 border-brand-green/20">
          <CardHeader className="text-center pb-6">
            <div className="flex justify-center mb-4">
              <CheckCircle className="w-16 h-16 text-brand-green" />
            </div>
            <CardTitle className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
              Your Order is Processing!
            </CardTitle>
            <p className="text-lg text-gray-600 dark:text-gray-400 break-words">
              We're working on <span className="break-all">{videoName}</span> right now
            </p>
          </CardHeader>
          
          <CardContent className="space-y-6">
            {/* Email Confirmation */}
            <div className="bg-gradient-to-r from-green-50 to-lime-50 dark:from-green-900/20 dark:to-lime-900/20 p-4 rounded-lg border border-brand-green/30">
              <div className="flex items-center gap-3 mb-2">
                <Mail className="w-5 h-5 text-brand-green" />
                <span className="font-medium text-gray-900 dark:text-white">Email Delivery Confirmed</span>
              </div>
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                Your files will be delivered to:
              </p>
              <p className="font-mono text-sm bg-white dark:bg-gray-800 px-3 py-2 rounded border text-brand-green font-medium break-all">
                {userEmail || user?.email || 'Loading email...'}
              </p>
              
              {/* Email Fallback */}
              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  Didn't get your email? Check your spam folder or:
                </p>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => window.location.href = '/support?subject=Missing Email'}
                  className="text-xs"
                >
                  Contact Support
                </Button>
              </div>
            </div>

            {/* Results Location - Clear CTAs */}
            {!isCompleted && (
              <div className="bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 p-6 rounded-lg border border-purple-200 dark:border-purple-800">
                <div className="text-center space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Where to Find Your Results
                  </h3>
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    Your processed files will be available in two places:
                  </p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                    {/* Email CTA */}
                    <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                      <Mail className="w-8 h-8 text-brand-green mx-auto mb-3" />
                      <h4 className="font-semibold text-gray-900 dark:text-white mb-2">Check Your Email</h4>
                      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                        Download links will be sent to your email immediately after processing completes
                      </p>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="w-full text-xs"
                        onClick={() => window.open('https://gmail.com', '_blank')}
                      >
                        Open Email
                      </Button>
                    </div>

                    {/* Dashboard CTA */}
                    <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                      <Download className="w-8 h-8 text-brand-green mx-auto mb-3" />
                      <h4 className="font-semibold text-gray-900 dark:text-white mb-2">Visit Dashboard</h4>
                      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                        Access all your processed files and download history
                      </p>
                      <Button 
                        variant="default" 
                        size="sm" 
                        className="w-full text-xs bg-brand-green hover:bg-brand-green/90"
                        onClick={() => window.location.href = '/dashboard'}
                      >
                        Go to Dashboard
                      </Button>
                    </div>
                  </div>

                  {/* Live progress if connected */}
                  {progressData && isConnected && (
                    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                      <div className="flex justify-between items-center text-sm mb-2">
                        <span className="text-gray-700 dark:text-gray-300">
                          {progressData.currentOperation || 'Processing...'}
                        </span>
                        <span className="font-medium text-brand-green">
                          {Math.round(progressData.progress)}%
                        </span>
                      </div>
                      <Progress value={progressData.progress} className="w-full" />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Completion Status */}
            {isCompleted && (
              <div className="bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 p-4 rounded-lg border border-green-200 dark:border-green-800">
                <div className="flex items-center gap-3 mb-2">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="font-medium text-gray-900 dark:text-white">Processing Complete!</span>
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                  Your files have been processed and are being delivered to your email.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  {downloadUrl && (
                    <a
                      href={downloadUrl}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
                    >
                      <Download className="w-4 h-4" />
                      Download Files
                    </a>
                  )}
                  {canBulkDownload && sessionId && (
                    <button
                      onClick={handleBulkDownload}
                      disabled={isDownloadingZip}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-brand-green text-brand-black rounded-lg hover:bg-brand-green-light transition-colors text-sm font-medium disabled:opacity-50"
                    >
                      <Archive className="w-4 h-4" />
                      {isDownloadingZip ? 'Creating ZIP...' : 'Download All as ZIP'}
                    </button>
                  )}
                  <Button
                    onClick={() => window.location.href = '/app/dashboard'}
                    variant="outline"
                    className="border-green-200 text-green-700 hover:bg-green-50"
                  >
                    <BarChart3 className="w-4 h-4 mr-2" />
                    View Dashboard
                  </Button>
                </div>
              </div>
            )}

            {/* Processing Timeline */}
            <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
              <div className="flex items-center gap-3 mb-3">
                <Clock className="w-5 h-5 text-blue-600" />
                <span className="font-medium text-gray-900 dark:text-white">Expected Timeline</span>
              </div>
              <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <div className="flex justify-between">
                  <span>Processing Start:</span>
                  <span className="font-medium text-brand-green">Now</span>
                </div>
                <div className="flex justify-between">
                  <span>Estimated Completion:</span>
                  <span className="font-medium">2-5 minutes</span>
                </div>
                <div className="flex justify-between">
                  <span>Email Delivery:</span>
                  <span className="font-medium">Immediately after completion</span>
                </div>
              </div>
            </div>

            {/* What's Being Generated */}
            <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
              <h3 className="font-medium text-gray-900 dark:text-white mb-2">What You'll Receive:</h3>
              <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                <div>• Professional video cutdowns in your selected format(s)</div>
                <div>• High-quality GIFs (if selected)</div>
                <div>• HD thumbnails (if selected)</div>
                <div>• Spotify Canvas loops (if selected)</div>
                <div>• All files organized in a convenient ZIP download</div>
              </div>
            </div>

            {/* Professional Quality Notice */}
            <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg border border-green-200 dark:border-green-800">
              <h3 className="font-medium text-gray-900 dark:text-white mb-2">Professional Quality:</h3>
              <div className="text-sm text-gray-700 dark:text-gray-300">
                <div>• All exports are clean and watermark-free</div>
                <div>• Professional quality ready for commercial use</div>
              </div>
            </div>

            {/* What to Do Next */}
            <div className="text-center pt-4">
              <h3 className="font-medium text-gray-900 dark:text-white mb-2">What to do next:</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                You can safely close this page. We'll email you as soon as your files are ready — no need to wait or refresh.
              </p>
              
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Link href="/">
                  <Button variant="outline" className="w-full sm:w-auto">
                    Process Another Video
                  </Button>
                </Link>
                <Button 
                  onClick={() => window.location.href = '/app/dashboard'}
                  variant="outline" 
                  className="w-full sm:w-auto border-green-200 text-green-700 hover:bg-green-50"
                >
                  <BarChart3 className="w-4 h-4 mr-2" />
                  View Dashboard
                </Button>
                <a href="https://www.fulldigitalll.com" target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" className="w-full sm:w-auto">
                    Visit Full Digital
                  </Button>
                </a>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Footer */}
      <footer className="bg-brand-black border-t border-gray-800 mt-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-center">
            <div className="flex items-center text-gray-300">
              <span className="text-sm">Powered by</span>
              <img src={fdLogo} alt="Full Digital" className="h-6 w-6 mx-2" />
              <a 
                href="https://www.fulldigitalll.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-brand-green hover:text-brand-green-light transition-colors text-sm font-medium"
              >
                Full Digital
              </a>
            </div>
          </div>
          <div className="text-center mt-2">
            <p className="text-xs text-gray-400">
              Multi-Platinum Design Agency - Artwork, Animation, AR Filters, Visualizers, Websites & More
            </p>
            <div className="text-xs text-gray-500 mt-1 border-t border-gray-800 pt-2 space-y-1">
              <p>
                <a href="/" className="text-brand-green hover:text-brand-green-light underline">
                  Home
                </a>{" "}
                •{" "}
                <a href="/support" className="text-brand-green hover:text-brand-green-light underline">
                  Support
                </a>{" "}
                •{" "}
                <a href="/terms" className="text-brand-green hover:text-brand-green-light underline">
                  Terms
                </a>{" "}
                •{" "}
                <a href="/privacy" className="text-brand-green hover:text-brand-green-light underline">
                  Privacy
                </a>
              </p>
              <p>© 2026 Full Digital LLC. All rights reserved.</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}