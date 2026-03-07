/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Referral System Page
 * Complete referral program management
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { 
  Users, 
  Gift, 
  Copy, 
  Share, 
  DollarSign,
  TrendingUp,
  Star,
  Check,
  Edit3,
  Save,
  X,
  Mail,
  MessageSquare,
  RefreshCw
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import FaviconProvider from '@/components/FaviconProvider';
import DashboardLayout from '@/components/DashboardLayout';
import { useAuth, AuthGuard } from '@/components/AuthGuard';

export default function ReferralsPage() {
  const { user, isLoading } = useAuth();
  const [referralCode, setReferralCode] = useState('');
  const [referralUrl, setReferralUrl] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [shareMessages, setShareMessages] = useState({
    shareMessage: '',
    socialShareText: '',
    emailShareText: ''
  });
  const [referralStats, setReferralStats] = useState({
    totalReferrals: 0,
    creditsEarned: 0,
    pendingCredits: 0
  });
  const { toast } = useToast();

  // Demo mode for testing without authentication
  const isDemoMode = !user && !isLoading;

  useEffect(() => {
    if (user) {
      // Use the user data from AuthGuard like the profile page does
      setReferralCode(user.referralCode || '');
      setReferralUrl(user.referralCode ? `https://cutmv.fulldigitalll.com/referral/${user.referralCode}` : '');
      setNewCode(user.referralCode || '');
      setReferralStats({
        totalReferrals: user.referralCount || 0,
        creditsEarned: user.credits || 0,
        pendingCredits: 0
      });
      
      // Set default share messages if not already set
      if (user.referralCode) {
        const baseUrl = `https://cutmv.fulldigitalll.com/referral/${user.referralCode}`;
        setShareMessages({
          shareMessage: `Transform your music videos into viral content with CUTMV! 🎵✨ Join using my referral link and start creating professional clips instantly: ${baseUrl}`,
          socialShareText: `🎬 Discover CUTMV - AI-powered video editing for creators! Transform your music videos into clips, GIFs, and thumbnails in seconds. Sign up with my link: ${baseUrl} #CUTMV #VideoEditing #MusicVideo`,
          emailShareText: `Hey! I wanted to share CUTMV with you - it's an amazing AI-powered video editing platform that helps creators turn music videos into viral content.\n\nWith CUTMV you can:\n• Create perfect video clips from timestamps\n• Generate eye-catching GIFs and thumbnails\n• Export optimized content for all platforms\n• Professional quality with zero watermarks\n\nUse my referral link to get started: ${baseUrl}\n\nThanks!\n`
        });
      }
    } else if (isDemoMode) {
      // Demo data for testing UI
      setReferralCode('demo123');
      setReferralUrl('https://cutmv.fulldigitalll.com/referral/demo123');
      setNewCode('demo123');
      setShareMessages({
        shareMessage: 'Transform your music videos into viral content with CUTMV! 🎵✨ Join using my referral link and start creating professional clips instantly: https://cutmv.fulldigitalll.com/referral/demo123',
        socialShareText: '🎬 Discover CUTMV - AI-powered video editing for creators! Transform your music videos into clips, GIFs, and thumbnails in seconds. Sign up with my link: https://cutmv.fulldigitalll.com/referral/demo123 #CUTMV #VideoEditing #MusicVideo',
        emailShareText: 'Hey! I wanted to share CUTMV with you - it\'s an amazing AI-powered video editing platform that helps creators turn music videos into viral content.\n\nWith CUTMV you can:\n• Create perfect video clips from timestamps\n• Generate eye-catching GIFs and thumbnails\n• Export optimized content for all platforms\n• Professional quality with zero watermarks\n\nUse my referral link to get started: https://cutmv.fulldigitalll.com/referral/demo123\n\nThanks!\n'
      });
      setReferralStats({
        totalReferrals: 5,
        creditsEarned: 12,
        pendingCredits: 3
      });
    }
  }, [user, isDemoMode]);

  const fetchReferralData = async () => {
    try {
      // Fetch referral code and URLs
      const codeResponse = await fetch('/api/referrals/code', {
        credentials: 'include'
      });
      if (codeResponse.ok) {
        const codeData = await codeResponse.json();
        setReferralCode(codeData.referralCode || '');
        setReferralUrl(codeData.referralUrl || '');
        setNewCode(codeData.referralCode || '');
        setShareMessages({
          shareMessage: codeData.shareMessage || '',
          socialShareText: codeData.socialShareText || '',
          emailShareText: codeData.emailShareText || ''
        });
      }

      // Fetch referral stats
      const statsResponse = await fetch('/api/referrals/stats', {
        credentials: 'include'
      });
      if (statsResponse.ok) {
        const statsData = await statsResponse.json();
        setReferralStats(statsData.stats || referralStats);
      }
    } catch (error) {
      console.error('Error fetching referral data:', error);
    }
  };

  const copyReferralLink = () => {
    navigator.clipboard.writeText(referralUrl);
    toast({
      title: "Link Copied!",
      description: "Your referral link has been copied to clipboard.",
    });
  };

  const copyShareMessage = (type: 'social' | 'email' | 'basic') => {
    let textToCopy = '';
    let description = '';
    
    switch (type) {
      case 'social':
        textToCopy = shareMessages.socialShareText;
        description = "Social media share text copied to clipboard.";
        break;
      case 'email':
        textToCopy = shareMessages.emailShareText;
        description = "Email share text copied to clipboard.";
        break;
      default:
        textToCopy = shareMessages.shareMessage;
        description = "Share message copied to clipboard.";
    }
    
    navigator.clipboard.writeText(textToCopy);
    toast({
      title: "Copied!",
      description,
    });
  };

  const shareReferralLink = () => {
    if (navigator.share) {
      navigator.share({
        title: 'CUTMV - AI Video Creation',
        text: shareMessages.shareMessage,
        url: referralUrl
      });
    } else {
      copyShareMessage('basic');
    }
  };

  const updateReferralCode = async () => {
    try {
      const response = await fetch('/api/referrals/code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newCode })
      });

      if (response.ok) {
        const data = await response.json();
        setReferralCode(data.referralCode);
        setReferralUrl(data.referralUrl);
        setIsEditing(false);
        toast({
          title: "Code Updated!",
          description: "Your custom referral code has been saved.",
        });
        // Refresh share messages with new URL
        fetchReferralData();
      } else {
        const error = await response.json();
        toast({
          title: "Update Failed",
          description: error.error || "Failed to update referral code.",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update referral code.",
        variant: "destructive",
      });
    }
  };

  const cancelEdit = () => {
    setNewCode(referralCode);
    setIsEditing(false);
  };

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

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-brand-green"></div>
      </div>
    );
  }

  // Demo mode rendering without authentication
  if (isDemoMode) {
    return (
      <FaviconProvider 
        title="Referral Program - CUTMV | Full Digital"
        description="Earn credits by referring friends to CUTMV. Get $1 credit for every successful referral to our AI-powered video platform."
      >
        <div className="min-h-screen bg-gray-50">
          {/* Demo Header */}
          <div className="bg-brand-black text-white p-4">
            <div className="max-w-7xl mx-auto flex justify-between items-center">
              <h1 className="text-xl font-bold">CUTMV Referral System Demo</h1>
              <Badge variant="secondary" className="bg-brand-green text-brand-black">
                Demo Mode
              </Badge>
            </div>
          </div>

          <div className="max-w-4xl mx-auto p-6">
            {/* Page Header */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900">Referral Program</h1>
                  <p className="text-gray-600">Earn credits by sharing CUTMV with friends</p>
                </div>
              </div>
            </div>

            {/* Referral Formula */}
            <Card className="mb-8 bg-gradient-to-r from-brand-green/10 to-brand-green/5 border-brand-green/20">
              <CardContent className="py-8">
                <div className="text-center">
                  <div className="flex items-center justify-center space-x-4 text-2xl font-bold text-gray-900 mb-4">
                    <span className="flex items-center">
                      <Users className="w-6 h-6 mr-2 text-brand-green" />
                      1 Referral
                    </span>
                    <span>=</span>
                    <span className="flex items-center">
                      <DollarSign className="w-6 h-6 mr-2 text-brand-green" />
                      1 Credit
                    </span>
                    <span>=</span>
                    <span className="flex items-center">
                      <Gift className="w-6 h-6 mr-2 text-brand-green" />
                      $1 Value
                    </span>
                  </div>
                  <p className="text-gray-600">Simple, transparent rewards for every friend who joins</p>
                </div>
              </CardContent>
            </Card>

            <div className="grid md:grid-cols-2 gap-8">
              {/* Referral Link Section */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Share className="w-5 h-5" />
                    Share Your Link
                  </CardTitle>
                  <CardDescription>
                    Share this link with friends to earn credits when they join CUTMV
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-6">
                    {/* Referral Code Section */}
                    <div>
                      <Label className="text-sm font-medium text-gray-700 mb-2 block">
                        Your Referral Code
                      </Label>
                      <div className="flex gap-2">
                        {isEditing ? (
                          <>
                            <Input 
                              value={newCode}
                              onChange={(e) => setNewCode(e.target.value.toLowerCase())}
                              placeholder="Enter custom code (3-15 characters)"
                              className="flex-1"
                              maxLength={15}
                            />
                            <Button variant="outline" size="sm" onClick={updateReferralCode}>
                              <Save className="w-4 h-4" />
                            </Button>
                            <Button variant="outline" size="sm" onClick={cancelEdit}>
                              <X className="w-4 h-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Input 
                              value={referralCode}
                              readOnly 
                              className="bg-gray-50 flex-1 font-mono"
                            />
                            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                              <Edit3 className="w-4 h-4" />
                            </Button>
                            <Button variant="outline" size="sm" onClick={copyReferralLink}>
                              <Copy className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
                      {isEditing && (
                        <p className="text-xs text-gray-500 mt-1">
                          Use letters and numbers only (3-15 characters)
                        </p>
                      )}
                    </div>

                    {/* Referral Link Section */}
                    <div>
                      <Label className="text-sm font-medium text-gray-700 mb-2 block">
                        Your Referral Link
                      </Label>
                      <div className="flex gap-2">
                        <Input 
                          value={referralUrl}
                          readOnly 
                          className="bg-gray-50 text-sm flex-1"
                        />
                        <Button variant="outline" size="sm" onClick={copyReferralLink}>
                          <Copy className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>

                    <Separator />

                    {/* Quick Actions */}
                    <div className="flex gap-3 flex-wrap">
                      <Button 
                        onClick={copyReferralLink}
                        className="bg-brand-green hover:bg-brand-green-light text-brand-black font-semibold"
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Copy Link
                      </Button>
                      
                      <Button 
                        variant="outline" 
                        onClick={shareReferralLink}
                      >
                        <Share className="w-4 h-4 mr-2" />
                        Share
                      </Button>

                      <Button 
                        variant="outline" 
                        onClick={() => copyShareMessage('social')}
                      >
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Social Text
                      </Button>

                      <Button 
                        variant="outline" 
                        onClick={() => copyShareMessage('email')}
                      >
                        <Mail className="w-4 h-4 mr-2" />
                        Email Text
                      </Button>
                    </div>

                    {/* Share Message Previews */}
                    <div className="space-y-4">
                      <div>
                        <Label className="text-sm font-medium text-gray-700 mb-2 block">
                          Quick Share Message
                        </Label>
                        <div className="bg-gray-50 border rounded-lg p-3">
                          <p className="text-sm text-gray-800">{shareMessages.shareMessage}</p>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="mt-2 h-8"
                            onClick={() => copyShareMessage('basic')}
                          >
                            <Copy className="w-3 h-3 mr-1" />
                            Copy
                          </Button>
                        </div>
                      </div>

                      <div>
                        <Label className="text-sm font-medium text-gray-700 mb-2 block">
                          Social Media Post
                        </Label>
                        <div className="bg-gray-50 border rounded-lg p-3">
                          <p className="text-sm text-gray-800 whitespace-pre-line">{shareMessages.socialShareText}</p>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="mt-2 h-8"
                            onClick={() => copyShareMessage('social')}
                          >
                            <Copy className="w-3 h-3 mr-1" />
                            Copy
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Stats Section */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="w-5 h-5" />
                    Your Progress
                  </CardTitle>
                  <CardDescription>
                    Track your referral success and earned credits
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="bg-brand-green/10 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-600">Total Referrals</p>
                          <p className="text-2xl font-bold text-gray-900">{referralStats.totalReferrals}</p>
                        </div>
                        <Users className="w-8 h-8 text-brand-green" />
                      </div>
                    </div>
                    
                    <div className="bg-green-50 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-600">Credits Earned</p>
                          <p className="text-2xl font-bold text-gray-900">{referralStats.creditsEarned}</p>
                        </div>
                        <Gift className="w-8 h-8 text-green-600" />
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-yellow-50 rounded-lg p-4 mb-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-600">Pending Credits</p>
                        <p className="text-lg font-bold text-gray-900">{referralStats.pendingCredits}</p>
                        <p className="text-xs text-gray-500">Awaiting first export</p>
                      </div>
                      <Star className="w-6 h-6 text-yellow-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </FaviconProvider>
    );
  }

  return (
    <AuthGuard>
      <FaviconProvider 
        title="Referral Program - CUTMV | Full Digital"
        description="Earn credits by referring friends to CUTMV. Get $1 credit for every successful referral to our AI-powered video platform."
      >
        <DashboardLayout currentUser={user} onLogout={handleLogout}>
        <div className="p-6">
          {/* Page Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Referral Program</h1>
                <p className="text-gray-600">Earn credits by sharing CUTMV with friends</p>
              </div>

            </div>
          </div>

          {/* Referral Formula */}
          <Card className="mb-8 bg-gradient-to-r from-brand-green/10 to-brand-green/5 border-brand-green/20">
            <CardContent className="py-8">
              <div className="text-center">
                <div className="flex items-center justify-center space-x-4 text-2xl font-bold text-gray-900 mb-4">
                  <span className="flex items-center">
                    <Users className="w-6 h-6 mr-2 text-brand-green" />
                    1 Referral
                  </span>
                  <span>=</span>
                  <span className="flex items-center">
                    <Gift className="w-6 h-6 mr-2 text-brand-green" />
                    1 Credit
                  </span>
                  <span>=</span>
                  <span className="flex items-center">
                    <DollarSign className="w-6 h-6 mr-2 text-brand-green" />
                    $1 Value
                  </span>
                </div>
                <p className="text-gray-600">
                  Every friend who joins CUTMV through your link gives you $1 in platform credits
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Stats Cards */}
            <div className="lg:col-span-1 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-brand-green" />
                    Your Stats
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-brand-green">{referralStats.totalReferrals}</div>
                    <div className="text-sm text-gray-600">Total Referrals</div>
                  </div>
                  
                  <div className="text-center">
                    <div className="text-3xl font-bold text-gray-900">${referralStats.creditsEarned}</div>
                    <div className="text-sm text-gray-600">Credits Earned</div>
                  </div>
                  
                  {referralStats.pendingCredits > 0 && (
                    <div className="text-center">
                      <div className="text-xl font-semibold text-orange-600">${referralStats.pendingCredits}</div>
                      <div className="text-sm text-gray-600">Pending Credits</div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Star className="w-5 h-5 text-yellow-500" />
                    Referral Benefits
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-green-500" />
                    Instant $1 credit per referral
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-green-500" />
                    Credits never expire
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-green-500" />
                    Use credits for any export type
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-green-500" />
                    No referral limits
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Referral Link Section */}
            <div className="lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Share Your Referral Link</CardTitle>
                  <CardDescription>
                    Share this link with friends to earn credits when they join CUTMV
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {referralCode ? (
                    <>
                      <div className="space-y-6">
                        {/* Referral Code Section */}
                        <div>
                          <Label className="text-sm font-medium text-gray-700 mb-2 block">
                            Your Referral Code
                          </Label>
                          <div className="flex gap-2">
                            {isEditing ? (
                              <>
                                <Input 
                                  value={newCode}
                                  onChange={(e) => setNewCode(e.target.value.toLowerCase())}
                                  placeholder="Enter custom code (3-15 characters)"
                                  className="flex-1"
                                  maxLength={15}
                                />
                                <Button variant="outline" size="sm" onClick={updateReferralCode}>
                                  <Save className="w-4 h-4" />
                                </Button>
                                <Button variant="outline" size="sm" onClick={cancelEdit}>
                                  <X className="w-4 h-4" />
                                </Button>
                              </>
                            ) : (
                              <>
                                <Input 
                                  value={referralCode}
                                  readOnly 
                                  className="bg-gray-50 flex-1 font-mono"
                                />
                                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                                  <Edit3 className="w-4 h-4" />
                                </Button>
                                <Button variant="outline" size="sm" onClick={copyReferralLink}>
                                  <Copy className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                          </div>
                          {isEditing && (
                            <p className="text-xs text-gray-500 mt-1">
                              Use letters and numbers only (3-15 characters)
                            </p>
                          )}
                        </div>

                        {/* Referral Link Section */}
                        <div>
                          <Label className="text-sm font-medium text-gray-700 mb-2 block">
                            Your Referral Link
                          </Label>
                          <div className="flex gap-2">
                            <Input 
                              value={referralUrl}
                              readOnly 
                              className="bg-gray-50 text-sm flex-1"
                            />
                            <Button variant="outline" size="sm" onClick={copyReferralLink}>
                              <Copy className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>

                        <Separator />

                        {/* Quick Actions */}
                        <div className="flex gap-3 flex-wrap">
                          <Button 
                            onClick={copyReferralLink}
                            className="bg-brand-green hover:bg-brand-green-light text-brand-black font-semibold"
                          >
                            <Copy className="w-4 h-4 mr-2" />
                            Copy Link
                          </Button>
                          
                          <Button 
                            variant="outline" 
                            onClick={shareReferralLink}
                          >
                            <Share className="w-4 h-4 mr-2" />
                            Share
                          </Button>

                          <Button 
                            variant="outline" 
                            onClick={() => copyShareMessage('social')}
                          >
                            <MessageSquare className="w-4 h-4 mr-2" />
                            Social Text
                          </Button>

                          <Button 
                            variant="outline" 
                            onClick={() => copyShareMessage('email')}
                          >
                            <Mail className="w-4 h-4 mr-2" />
                            Email Text
                          </Button>
                        </div>

                        {/* Share Message Previews */}
                        <div className="space-y-4">
                          <div>
                            <Label className="text-sm font-medium text-gray-700 mb-2 block">
                              Quick Share Message
                            </Label>
                            <div className="bg-gray-50 border rounded-lg p-3">
                              <p className="text-sm text-gray-800">{shareMessages.shareMessage}</p>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="mt-2 h-8"
                                onClick={() => copyShareMessage('basic')}
                              >
                                <Copy className="w-3 h-3 mr-1" />
                                Copy
                              </Button>
                            </div>
                          </div>

                          <div>
                            <Label className="text-sm font-medium text-gray-700 mb-2 block">
                              Social Media Post
                            </Label>
                            <div className="bg-gray-50 border rounded-lg p-3">
                              <p className="text-sm text-gray-800 whitespace-pre-line">{shareMessages.socialShareText}</p>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="mt-2 h-8"
                                onClick={() => copyShareMessage('social')}
                              >
                                <Copy className="w-3 h-3 mr-1" />
                                Copy
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <h4 className="font-medium text-blue-900 mb-2">How it works:</h4>
                        <ol className="text-sm text-blue-800 space-y-1">
                          <li>1. Share your referral link with friends</li>
                          <li>2. When they sign up using your link, you get $1 credit</li>
                          <li>3. Credits are added to your account instantly</li>
                          <li>4. Use credits for any CUTMV export type</li>
                        </ol>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-8">
                      <div className="flex items-center justify-center mb-4">
                        <RefreshCw className="w-8 h-8 text-brand-green animate-spin" />
                      </div>
                      <h3 className="text-lg font-medium text-gray-900 mb-2">
                        Generating your referral code...
                      </h3>
                      <p className="text-gray-600 mb-4">
                        Your unique referral code is being created automatically
                      </p>
                      <Button 
                        variant="outline" 
                        onClick={fetchReferralData}
                        className="mt-2"
                      >
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Refresh
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </DashboardLayout>
    </FaviconProvider>
    </AuthGuard>
  );
}