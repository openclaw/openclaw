/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - User Dashboard
 * Export history and account management
 */

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Download,
  Clock,
  Video,
  Image,
  FileText,
  Music,
  Upload,
  RefreshCw,
  AlertCircle,
  Loader,
  Play,
  CreditCard,
  Sparkles,
  Eye
} from 'lucide-react';

import FaviconProvider from '@/components/FaviconProvider';
import DashboardLayout from '@/components/DashboardLayout';
import { useToast } from '@/hooks/use-toast';
import { useAuth, AuthGuard } from '@/components/AuthGuard';
import { CreditBalance } from '@/components/referral/CreditBalance';
import CreditPurchase from '@/components/CreditPurchase';
import { ExportPreview } from '@/components/ExportPreview';

// Dashboard data types
interface DashboardUpload {
  id: number;
  filename: string;
  originalName: string;
  size: number;
  duration?: string;
  uploadedAt: string;
  expiresAt: string;
  status: 'active' | 'expired';
}

interface DashboardExport {
  id: string;
  sessionId: string;
  videoId: number;
  filename: string;
  downloadPath?: string;
  originalVideoName?: string;
  format: string;
  aspectRatio?: string;
  timestampCount?: number;
  downloadUrl?: string;
  fileSize?: number;
  status: 'processing' | 'completed' | 'failed' | 'expired';
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  previewUrl?: string; // Preview thumbnail URL
}

// Subscription status type
interface SubscriptionStatus {
  hasActiveSubscription: boolean;
  plan?: {
    id: string;
    name: string;
    monthlyCredits: number;
    price: number;
    hasBulkDownload: boolean;
  };
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
}

export default function DashboardPage() {
  const { user, isLoading } = useAuth();
  const [uploads, setUploads] = useState<DashboardUpload[]>([]);
  const [exports, setExports] = useState<DashboardExport[]>([]);
  const [activeTab, setActiveTab] = useState<'uploads' | 'exports'>('exports');
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [previewExport, setPreviewExport] = useState<DashboardExport | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (user) {
      fetchDashboardData();
    }
  }, [user]);

  // Fetch preview thumbnails for completed exports
  useEffect(() => {
    const fetchPreviews = async () => {
      const exportsWithoutPreviews = exports.filter(
        exp => exp.status === 'completed' && !exp.previewUrl
      );

      for (const exportItem of exportsWithoutPreviews) {
        try {
          const response = await fetch(`/api/user/exports/${exportItem.id}/preview`, {
            credentials: 'include',
          });

          if (response.ok) {
            const data = await response.json();
            // Update the export with the preview URL
            setExports(prev => prev.map(exp =>
              exp.id === exportItem.id
                ? { ...exp, previewUrl: data.previewUrl }
                : exp
            ));
          }
        } catch (error) {
          console.error(`Failed to fetch preview for export ${exportItem.id}:`, error);
        }
      }
    };

    if (exports.length > 0) {
      fetchPreviews();
    }
  }, [exports.length]); // Only run when exports list changes

  // AUTO-REFRESH: Poll for processing exports to update status automatically
  useEffect(() => {
    const processingExports = exports.filter(exp => exp.status === 'processing');

    if (processingExports.length === 0) {
      return; // No processing exports, no need to poll
    }

    console.log(`🔄 Polling for ${processingExports.length} processing export(s)...`);

    const pollInterval = setInterval(async () => {
      try {
        // Re-fetch exports to get updated statuses
        const exportsResponse = await fetch('/api/user/exports', {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          }
        });

        if (exportsResponse.ok) {
          const exportsData = await exportsResponse.json();
          const exportsArray = Array.isArray(exportsData.exports) ? exportsData.exports : [];

          // Sort exports by createdAt timestamp (newest first)
          const sortedExports = exportsArray.toSorted((a: DashboardExport, b: DashboardExport) => {
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          });

          setExports(sortedExports);

          // Check if any exports completed
          const nowCompleted = sortedExports.filter((exp: DashboardExport) =>
            exp.status === 'completed' &&
            processingExports.some(pe => pe.id === exp.id)
          );

          if (nowCompleted.length > 0) {
            console.log(`✅ ${nowCompleted.length} export(s) completed!`);
            toast({
              title: "Export Ready!",
              description: `${nowCompleted.length} export${nowCompleted.length > 1 ? 's' : ''} finished processing and ready to download.`,
            });
          }
        }
      } catch (error) {
        console.error('Export status polling error:', error);
      }
    }, 5000); // Poll every 5 seconds

    // Cleanup interval on unmount or when processing exports change
    return () => clearInterval(pollInterval);
  }, [exports.filter(exp => exp.status === 'processing').length]);

  const fetchDashboardData = async () => {
    setDashboardLoading(true);
    try {
      console.log('🔄 Fetching dashboard data...');
      
      // Fetch uploads
      try {
        const uploadsResponse = await fetch('/api/user/uploads', { 
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });

        console.log('📊 Upload response status:', uploadsResponse.status);

        if (uploadsResponse.ok) {
          const uploadsData = await uploadsResponse.json();
          console.log('📂 Uploads data received:', uploadsData);
          const uploadsArray = Array.isArray(uploadsData.uploads) ? uploadsData.uploads : [];
          
          // Sort uploads by uploadedAt timestamp (newest first)
          const sortedUploads = uploadsArray.toSorted((a: DashboardUpload, b: DashboardUpload) => {
            return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
          });
          
          setUploads(sortedUploads);
          console.log('📂 Set uploads array length:', sortedUploads.length);
        } else if (uploadsResponse.status === 401) {
          console.log('📂 Authentication required for uploads');
          setUploads([]);
        } else {
          console.error('❌ Failed to fetch uploads:', uploadsResponse.status, uploadsResponse.statusText);
          const errorText = await uploadsResponse.text();
          console.error('📂 Upload error details:', errorText);
          setUploads([]);
        }
      } catch (uploadError) {
        console.error('❌ Upload fetch error:', uploadError);
        setUploads([]);
      }

      // Fetch exports
      try {
        const exportsResponse = await fetch('/api/user/exports', { 
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });

        console.log('📊 Export response status:', exportsResponse.status);

        if (exportsResponse.ok) {
          const exportsData = await exportsResponse.json();
          console.log('📤 Exports data received:', exportsData);
          const exportsArray = Array.isArray(exportsData.exports) ? exportsData.exports : [];
          
          // Sort exports by createdAt timestamp (newest first)
          const sortedExports = exportsArray.toSorted((a: DashboardExport, b: DashboardExport) => {
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          });
          
          setExports(sortedExports);
          console.log('📤 Set exports array length:', sortedExports.length);
        } else if (exportsResponse.status === 401) {
          console.log('📤 Authentication required for exports');
          setExports([]);
        } else {
          console.error('❌ Failed to fetch exports:', exportsResponse.status, exportsResponse.statusText);
          const errorText = await exportsResponse.text();
          console.error('📤 Export error details:', errorText);
          setExports([]);
        }
      } catch (exportError) {
        console.error('❌ Export fetch error:', exportError);
        setExports([]);
      }

      // Fetch subscription status
      try {
        const subscriptionResponse = await fetch('/api/subscription/status', {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });

        if (subscriptionResponse.ok) {
          const subscriptionData = await subscriptionResponse.json();
          console.log('💳 Subscription status:', subscriptionData);
          setSubscriptionStatus(subscriptionData);
        } else {
          console.log('💳 No subscription or not authenticated');
          setSubscriptionStatus({ hasActiveSubscription: false });
        }
      } catch (subscriptionError) {
        console.error('❌ Subscription fetch error:', subscriptionError);
        setSubscriptionStatus({ hasActiveSubscription: false });
      }

    } catch (error) {
      console.error('❌ Error fetching dashboard data:', error);
      setUploads([]);
      setExports([]);
      toast({
        title: "Error loading dashboard",
        description: "Failed to load your uploads and exports. Please try refreshing.",
        variant: "destructive"
      });
    } finally {
      setDashboardLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
      
      toast({
        title: "Logged out successfully",
        description: "You have been logged out of your account.",
      });
      
      window.location.href = '/';
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };

  // Handle re-export functionality 
  const handleReExport = async (videoId: number) => {
    try {
      console.log('🔄 Starting re-export for video ID:', videoId);
      
      // Find the upload for this video ID
      const upload = uploads.find(u => u.id === videoId);
      if (!upload) {
        console.error('❌ Upload not found for video ID:', videoId);
        toast({
          title: "Error",
          description: "Could not find the original upload. Please try again.",
          variant: "destructive"
        });
        return;
      }

      // Store the video data for the app page to use
      const videoData = {
        id: upload.id,
        filename: upload.originalName || upload.filename,
        size: upload.size,
        duration: upload.duration,
        uploadedAt: upload.uploadedAt
      };
      
      console.log('💾 Storing video data for reuse:', videoData);
      localStorage.setItem('reselectedUpload', JSON.stringify(videoData));
      
      // Generate encrypted reuse token for security
      const response = await fetch('/api/generate-reuse-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId })
      });
      
      if (!response.ok) {
        throw new Error('Failed to generate secure reuse token');
      }
      
      const { token } = await response.json();
      
      // Navigate to app with encrypted reuse token
      const appUrl = `/app?reuse=${token}`;
      console.log('🚀 Navigating to app with secure token');
      window.location.href = appUrl;
      
    } catch (error) {
      console.error('❌ Re-export error:', error);
      toast({
        title: "Error",
        description: "Failed to start re-export. Please try again.",
        variant: "destructive"
      });
    }
  };

  // Helper functions
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getExportIcon = (format: string) => {
    switch (format.toLowerCase()) {
      case 'cutdown':
        return <Video className="w-4 h-4" />;
      case 'gif':
        return <Image className="w-4 h-4" />;
      case 'thumbnail':
        return <FileText className="w-4 h-4" />;
      case 'canvas':
        return <Music className="w-4 h-4" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'processing':
        return 'bg-blue-100 text-blue-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'expired':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const isExportExpiringSoon = (expiresAt: string) => {
    const expiryDate = new Date(expiresAt);
    const now = new Date();
    const diffDays = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return diffDays <= 7 && diffDays > 0;
  };

  const getDaysUntilExpiration = (expiresAt: string) => {
    const expirationDate = new Date(expiresAt);
    const now = new Date();
    const diffInDays = Math.ceil((expirationDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(diffInDays, 0);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-brand-green"></div>
      </div>
    );
  }

  return (
    <AuthGuard>
      <FaviconProvider 
        title="Dashboard - CUTMV | Full Digital"
        description="Manage your CUTMV exports, view download history, and access account settings. Professional video processing platform by Full Digital."
      >
        <DashboardLayout currentUser={user} onLogout={handleLogout}>
          <div className="p-6">
            {/* Page Header */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900">Export Dashboard</h1>
                  <p className="text-gray-600">View and manage your video exports</p>
                </div>
                <Button onClick={() => {
                  // Force refresh by clearing any browser cache
                  if ('caches' in window) {
                    caches.keys().then(names => {
                      names.forEach(name => caches.delete(name));
                    });
                  }
                  fetchDashboardData();
                }} disabled={dashboardLoading}>
                  <RefreshCw className={`w-4 h-4 mr-2 ${dashboardLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              </div>
            </div>

            {/* Quick Stats and Credits */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Exports</CardTitle>
                  <Video className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{exports.length}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Active Files</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {exports.filter(e => e.status === 'completed' && new Date(e.expiresAt) > new Date()).length}
                  </div>
                </CardContent>
              </Card>

              <Card
                className="cursor-pointer hover:border-brand-green transition-colors"
                onClick={() => window.location.href = '/app/subscription'}
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Subscription</CardTitle>
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {subscriptionStatus?.hasActiveSubscription ? (
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xl font-bold text-brand-green">{subscriptionStatus.plan?.name}</span>
                        <Badge className="bg-brand-green text-white">Active</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        <Sparkles className="w-3 h-3 inline mr-1" />
                        50% off all processing
                      </p>
                    </div>
                  ) : (
                    <div>
                      <div className="text-lg font-bold text-muted-foreground">No Plan</div>
                      <Button
                        size="sm"
                        className="mt-2 bg-brand-green hover:bg-brand-green-light text-brand-black text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.location.href = '/app/subscription';
                        }}
                      >
                        Subscribe & Save 50%
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              <CreditBalance />
            </div>

            {/* Credit Purchase Section */}
            <div className="mb-8">
              <CreditPurchase onPurchaseComplete={fetchDashboardData} />
            </div>

            {/* Tabs for Uploads and Exports */}
            <div className="mb-6">
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'uploads' | 'exports')}>
                <TabsList className="grid w-full grid-cols-2 mb-4">
                  <TabsTrigger value="uploads" className="flex items-center gap-2">
                    <Upload className="w-4 h-4" />
                    Uploads (24h retention)
                  </TabsTrigger>
                  <TabsTrigger value="exports" className="flex items-center gap-2">
                    <Download className="w-4 h-4" />
                    Exports (29 days retention)
                  </TabsTrigger>
                </TabsList>

              {/* Uploads Tab */}
              <TabsContent value="uploads" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Upload className="w-5 h-5" />
                      Upload History
                    </CardTitle>
                    <CardDescription>
                      Your recent uploads. All uploads expire after 24 hours.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {dashboardLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader className="w-6 h-6 animate-spin" />
                        <span className="ml-2">Loading uploads...</span>
                      </div>
                    ) : uploads.length === 0 ? (
                      <div className="text-center py-8">
                        <Video className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                        <p className="text-gray-500">No uploads yet</p>
                        <p className="text-sm text-gray-400 mt-2">
                          Start creating content to see your upload history here.
                        </p>
                        <Button className="mt-4" onClick={() => window.location.href = '/app'}>
                          <Play className="w-4 h-4 mr-2" />
                          Create your first export
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {uploads.map((upload) => (
                          <div key={upload.id} className="p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                            {/* Mobile-first responsive layout */}
                            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                              {/* Video icon and details */}
                              <div className="flex items-center gap-4 flex-1 min-w-0">
                                <div className="relative flex-shrink-0">
                                  <Video className="w-10 h-10 text-muted-foreground" />
                                  <div className="absolute -bottom-1 -right-1 bg-background border rounded-full p-1">
                                    <Play className="w-3 h-3 text-green-600" />
                                  </div>
                                </div>
                                <div className="space-y-1 min-w-0 flex-1">
                                  <div className="font-medium text-base sm:text-lg truncate">{upload.originalName || upload.filename}</div>
                                  <div className="text-sm text-muted-foreground flex flex-wrap gap-2 sm:gap-4">
                                    <span>📁 {(upload.size / (1024 * 1024)).toFixed(1)} MB</span>
                                    <span className="hidden sm:inline">⏱️ {upload.duration || 'Unknown duration'}</span>
                                    <span>📅 {new Date(upload.uploadedAt).toLocaleDateString('en-US', { 
                                      month: 'short', 
                                      day: 'numeric', 
                                      year: 'numeric' 
                                    })}</span>
                                    <span className="hidden sm:inline">🕐 {new Date(upload.uploadedAt).toLocaleTimeString('en-US', {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                      hour12: true
                                    })}</span>
                                  </div>
                                </div>
                              </div>
                              
                              {/* Action buttons and status - stack on mobile */}
                              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:flex-shrink-0">
                                <Badge variant={upload.status === 'active' ? 'default' : 'secondary'} className="whitespace-nowrap self-start sm:self-center">
                                  {upload.status === 'active' ? 'Active' : 'EXPIRED'}
                                </Badge>
                                
                                <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
                                  {upload.status === 'active' && (
                                    <Button 
                                      size="sm" 
                                      onClick={() => {
                                        // Navigate to main tool with this video pre-selected
                                        const uploadData = {
                                          videoId: upload.id,
                                          filename: upload.originalName || upload.filename,
                                          size: upload.size,
                                          duration: upload.duration
                                        };
                                        localStorage.setItem('reselectedUpload', JSON.stringify(uploadData));
                                        window.location.href = '/app';
                                      }}
                                      className="bg-green-600 hover:bg-green-700 text-white w-full sm:w-auto"
                                    >
                                      <Play className="w-4 h-4 mr-2" />
                                      Create Export
                                    </Button>
                                  )}
                                  
                                  <div className="text-xs text-muted-foreground text-left sm:text-right">
                                    <div>Expires</div>
                                    <div className="font-medium">{new Date(upload.expiresAt).toLocaleDateString()}</div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Exports Tab */}
              <TabsContent value="exports" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Download className="w-5 h-5" />
                      Export History
                    </CardTitle>
                    <CardDescription>
                      Your recent exports and downloads. All files expire after 29 days.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {dashboardLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader className="w-6 h-6 animate-spin" />
                        <span className="ml-2">Loading exports...</span>
                      </div>
                    ) : exports.length === 0 ? (
                      <div className="text-center py-8">
                        <Video className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                        <p className="text-gray-500">No exports yet</p>
                        <p className="text-sm text-gray-400 mt-2">
                          Start creating content to see your export history here.
                        </p>
                        <Button className="mt-4" onClick={() => window.location.href = '/app'}>
                          <Play className="w-4 h-4 mr-2" />
                          Create your first export
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {exports.map((exportItem) => (
                          <div key={exportItem.id} className="p-4 border rounded-lg hover:bg-gray-50 transition-colors">
                            {/* Mobile-first responsive layout */}
                            <div className="flex flex-col sm:flex-row gap-4">
                              {/* Export icon and details */}
                              <div className="flex items-start gap-3 flex-1 min-w-0">
                                {/* Video thumbnail preview */}
                                <div className="w-24 h-24 bg-gray-300 rounded-lg overflow-hidden flex-shrink-0">
                                  {exportItem.previewUrl ? (
                                    <video
                                      src={exportItem.previewUrl}
                                      className="w-full h-full object-cover"
                                      preload="metadata"
                                      muted
                                      playsInline
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center bg-gray-200">
                                      {exportItem.status === 'completed' ? (
                                        <Loader className="text-gray-400 w-6 h-6 animate-spin" />
                                      ) : (
                                        getExportIcon(exportItem.format)
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium truncate">{exportItem.filename}</p>
                                  <div className="flex flex-wrap items-center gap-2 mt-1">
                                    <Badge className={getStatusColor(exportItem.status)}>
                                      {exportItem.status === 'failed' ? (
                                        <div className="flex items-center gap-1">
                                          <AlertCircle className="w-3 h-3" />
                                          Failed
                                        </div>
                                      ) : exportItem.status === 'processing' ? (
                                        <div className="flex items-center gap-1">
                                          <Loader className="w-3 h-3 animate-spin" />
                                          Processing
                                        </div>
                                      ) : exportItem.status === 'expired' ? (
                                        <div className="flex items-center gap-1">
                                          <Clock className="w-3 h-3" />
                                          EXPIRED
                                        </div>
                                      ) : (
                                        exportItem.status.charAt(0).toUpperCase() + exportItem.status.slice(1)
                                      )}
                                    </Badge>
                                    <span className="text-sm text-gray-500 break-all">
                                      {exportItem.format} • {exportItem.aspectRatio || '16:9'}
                                      {exportItem.timestampCount && ` • ${exportItem.timestampCount} clips`}
                                    </span>
                                  </div>
                                  <div className="text-xs text-gray-500 space-y-1 mt-2">
                                    <div>Created: {new Date(exportItem.createdAt).toLocaleDateString('en-US', { 
                                      month: 'short', 
                                      day: 'numeric', 
                                      year: 'numeric' 
                                    })} at {new Date(exportItem.createdAt).toLocaleTimeString('en-US', {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                      hour12: true
                                    })}</div>
                                    {exportItem.status === 'completed' && exportItem.completedAt && (
                                      <div>Completed: {new Date(exportItem.completedAt).toLocaleTimeString('en-US', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: true
                                      })}</div>
                                    )}
                                    {(exportItem.status === 'completed' || exportItem.status === 'expired') && (
                                      <div>
                                        Expires: {isExportExpiringSoon(exportItem.expiresAt) ? (
                                          <span className="text-orange-600 font-medium">
                                            Sep {getDaysUntilExpiration(exportItem.expiresAt)}, 2025 at {new Date(exportItem.expiresAt).toLocaleTimeString('en-US', {
                                              hour: '2-digit',
                                              minute: '2-digit',
                                              hour12: true
                                            })}
                                          </span>
                                        ) : (
                                          `${new Date(exportItem.expiresAt).toLocaleDateString('en-US', { 
                                            month: 'short', 
                                            day: 'numeric', 
                                            year: 'numeric' 
                                          })} at ${new Date(exportItem.expiresAt).toLocaleTimeString('en-US', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            hour12: true
                                          })}`
                                        )}
                                      </div>
                                    )}
                                    {exportItem.originalVideoName && (
                                      <div className="truncate">From: {exportItem.originalVideoName}</div>
                                    )}
                                  </div>
                                </div>
                              </div>
                              
                              {/* Action buttons - responsive layout */}
                              <div className="flex flex-row sm:flex-col gap-2 sm:gap-2 sm:flex-shrink-0 sm:min-w-[120px]">
                                {/* Preview button for completed exports */}
                                {exportItem.status === 'completed' && exportItem.downloadUrl && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setPreviewExport(exportItem)}
                                    className="flex-1 sm:flex-none"
                                  >
                                    <Eye className="w-4 h-4 sm:mr-0 mr-2" />
                                    <span className="sm:hidden">Preview</span>
                                  </Button>
                                )}

                                {/* Download button for completed exports */}
                                {exportItem.status === 'completed' && exportItem.downloadUrl && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      // Use secure download endpoint with proper token generation
                                      window.open(exportItem.downloadUrl, '_blank');
                                    }}
                                    className="flex-1 sm:flex-none"
                                  >
                                    <Download className="w-4 h-4 sm:mr-0 mr-2" />
                                    <span className="sm:hidden">Download</span>
                                  </Button>
                                )}
                                
                                {/* Show retry button for failed exports */}
                                {exportItem.status === 'failed' && exportItem.videoId && uploads.find(u => u.id === exportItem.videoId && u.status === 'active') && (
                                  <Button 
                                    size="sm" 
                                    variant="outline"
                                    onClick={() => handleReExport(exportItem.videoId)}
                                    title="Retry failed export with same upload"
                                    className="text-red-600 border-red-200 hover:bg-red-50 flex-1 sm:flex-none"
                                  >
                                    <RefreshCw className="w-4 h-4 sm:mr-0 mr-2" />
                                    <span className="sm:hidden">Retry</span>
                                  </Button>
                                )}
                                
                                {/* Re-export button for completed/expired uploads */}
                                {(exportItem.status === 'completed' || exportItem.status === 'expired') && exportItem.videoId && uploads.find(u => u.id === exportItem.videoId && u.status === 'active') && (
                                  <Button 
                                    size="sm" 
                                    variant="outline"
                                    onClick={() => handleReExport(exportItem.videoId)}
                                    title="Create new export using same upload"
                                    className="flex-1 sm:flex-none"
                                  >
                                    <RefreshCw className="w-4 h-4 sm:mr-0 mr-2" />
                                    <span className="sm:hidden">Re-export</span>
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
              </Tabs>
            </div>
          </div>
        </DashboardLayout>

        {/* Export Preview Modal */}
        {previewExport && (
          <ExportPreview
            exportId={previewExport.id}
            filename={previewExport.filename}
            format={previewExport.format}
            downloadUrl={previewExport.downloadUrl}
            aspectRatio={previewExport.aspectRatio}
            videoId={previewExport.videoId}
            isOpen={!!previewExport}
            onClose={() => setPreviewExport(null)}
          />
        )}
      </FaviconProvider>
    </AuthGuard>
  );
}