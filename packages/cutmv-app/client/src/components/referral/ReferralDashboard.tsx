/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Referral Dashboard Component
 * Complete referral system UI with credit tracking and sharing
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { 
  Gift, 
  Users, 
  Coins, 
  Share2, 
  Copy, 
  Twitter, 
  MessageCircle,
  Mail,
  TrendingUp,
  Calendar,
  Award,
  ExternalLink
} from 'lucide-react';
import { format } from 'date-fns';
import { useState } from 'react';

interface ReferralStats {
  totalReferrals: number;
  creditsEarned: number;
  creditsSpent: number;
  creditsAvailable: number;
  recentReferrals: Array<{
    email: string;
    eventType: string;
    createdAt: Date;
    creditsEarned: number;
  }>;
  creditHistory: Array<{
    type: string;
    amount: number;
    note: string;
    createdAt: Date;
    expiresAt?: Date;
  }>;
}

export function ReferralDashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sharingPlatform, setSharingPlatform] = useState<string | null>(null);

  // Get referral stats
  const { data: stats, isLoading: statsLoading } = useQuery<{ stats: ReferralStats }>({
    queryKey: ['/api/referral/stats'],
  });

  // Get referral code and URL
  const { data: referralData, isLoading: codeLoading } = useQuery<{
    referralCode: string;
    referralUrl: string;
    shareMessage: string;
  }>({
    queryKey: ['/api/referral/code'],
  });

  // Redeem credits mutation
  const redeemMutation = useMutation({
    mutationFn: async ({ amount, purpose }: { amount: number; purpose: string }) => {
      const response = await fetch('/api/referral/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount, purpose }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to redeem credits');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/referral/stats'] });
      toast({
        title: "Credits Redeemed",
        description: "Your credits have been successfully redeemed.",
      });
    },
    onError: (error) => {
      toast({
        title: "Redemption Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: "Copied!",
        description: "Referral link copied to clipboard",
      });
    } catch (error) {
      toast({
        title: "Copy Failed",
        description: "Failed to copy link to clipboard",
        variant: "destructive",
      });
    }
  };

  const shareOnPlatform = (platform: string) => {
    setSharingPlatform(platform);
    if (!referralData) return;

    const { referralUrl, shareMessage } = referralData;
    
    let shareUrl = '';
    
    switch (platform) {
      case 'twitter':
        shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}`;
        break;
      case 'whatsapp':
        shareUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
        break;
      case 'email':
        shareUrl = `mailto:?subject=${encodeURIComponent('Check out CUTMV - AI Video Editing')}&body=${encodeURIComponent(shareMessage)}`;
        break;
      default:
        return;
    }

    window.open(shareUrl, '_blank');
    setTimeout(() => setSharingPlatform(null), 2000);
  };

  const redeemCreditsForPayment = () => {
    redeemMutation.mutate({
      amount: 1,
      purpose: 'Payment credit applied'
    });
  };

  if (statsLoading || codeLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Referral Dashboard</h2>
          <Badge variant="outline">Loading...</Badge>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-3/4"></div>
              </CardHeader>
              <CardContent className="animate-pulse">
                <div className="h-8 bg-gray-200 rounded w-1/2"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const referralStats = stats?.stats;
  const nextRewardProgress = referralStats ? (referralStats.totalReferrals % 5) * 20 : 0;
  const nextRewardAt = referralStats ? Math.ceil(referralStats.totalReferrals / 5) * 5 : 5;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Referral Dashboard</h2>
          <p className="text-muted-foreground">Earn credits by referring friends to CUTMV</p>
        </div>
        <Badge variant="secondary" className="bg-green-100 text-green-800">
          <Gift className="w-4 h-4 mr-1" />
          1 Credit = $1 Value
        </Badge>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Referrals</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{referralStats?.totalReferrals || 0}</div>
            <p className="text-xs text-muted-foreground">
              People you've referred
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Credits Available</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{referralStats?.creditsAvailable || 0}</div>
            <p className="text-xs text-muted-foreground">
              Ready to use
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Credits Earned</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{referralStats?.creditsEarned || 0}</div>
            <p className="text-xs text-muted-foreground">
              Total earned all-time
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Credits Used</CardTitle>
            <Award className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{referralStats?.creditsSpent || 0}</div>
            <p className="text-xs text-muted-foreground">
              Redeemed for upgrades
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Progress to Next Reward */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="w-5 h-5" />
            Progress to Next Bonus
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Next bonus credit at {nextRewardAt} referrals</span>
              <span>{referralStats?.totalReferrals || 0} / {nextRewardAt}</span>
            </div>
            <Progress value={nextRewardProgress} className="h-2" />
            <p className="text-xs text-muted-foreground">
              Every 5 successful referrals earns you a bonus credit!
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Referral Link Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Share2 className="w-5 h-5" />
            Your Referral Link
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 p-3 bg-muted rounded-lg font-mono text-sm break-all">
              {referralData?.referralUrl || 'Loading...'}
            </div>
            <Button
              onClick={() => copyToClipboard(referralData?.referralUrl || '')}
              variant="outline"
              size="sm"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => shareOnPlatform('twitter')}
              variant="outline"
              size="sm"
              disabled={sharingPlatform === 'twitter'}
            >
              <Twitter className="w-4 h-4 mr-1" />
              {sharingPlatform === 'twitter' ? 'Opening...' : 'Share on X'}
            </Button>
            <Button
              onClick={() => shareOnPlatform('whatsapp')}
              variant="outline"
              size="sm"
              disabled={sharingPlatform === 'whatsapp'}
            >
              <MessageCircle className="w-4 h-4 mr-1" />
              {sharingPlatform === 'whatsapp' ? 'Opening...' : 'WhatsApp'}
            </Button>
            <Button
              onClick={() => shareOnPlatform('email')}
              variant="outline"
              size="sm"
              disabled={sharingPlatform === 'email'}
            >
              <Mail className="w-4 h-4 mr-1" />
              {sharingPlatform === 'email' ? 'Opening...' : 'Email'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Credit Actions */}
      {(referralStats?.creditsAvailable || 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="w-5 h-5" />
              Use Your Credits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <h3 className="font-medium">Apply Payment Credit</h3>
                <p className="text-sm text-muted-foreground">
                  Use credits to reduce your next export cost by $1
                </p>
              </div>
              <Button
                onClick={redeemCreditsForPayment}
                disabled={redeemMutation.isPending || (referralStats?.creditsAvailable || 0) < 1}
                size="sm"
              >
                {redeemMutation.isPending ? 'Applying...' : 'Use 1 Credit'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detailed History */}
      <Tabs defaultValue="referrals" className="w-full">
        <TabsList>
          <TabsTrigger value="referrals">Recent Referrals</TabsTrigger>
          <TabsTrigger value="credits">Credit History</TabsTrigger>
        </TabsList>

        <TabsContent value="referrals" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Referrals</CardTitle>
            </CardHeader>
            <CardContent>
              {referralStats?.recentReferrals?.length ? (
                <div className="space-y-3">
                  {referralStats.recentReferrals.map((referral, index) => (
                    <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-medium">{referral.email}</p>
                        <p className="text-sm text-muted-foreground">
                          {referral.eventType === 'signup' ? 'Signed up' : 'First export'} • {format(new Date(referral.createdAt), 'MMM d, yyyy')}
                        </p>
                      </div>
                      <Badge variant="secondary" className="bg-green-100 text-green-800">
                        +{referral.creditsEarned} credit{referral.creditsEarned !== 1 ? 's' : ''}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No referrals yet</p>
                  <p className="text-sm">Share your link to start earning credits!</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="credits" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Credit History</CardTitle>
            </CardHeader>
            <CardContent>
              {referralStats?.creditHistory?.length ? (
                <div className="space-y-3">
                  {referralStats.creditHistory.map((transaction, index) => (
                    <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-medium">{transaction.note}</p>
                        <p className="text-sm text-muted-foreground">
                          {format(new Date(transaction.createdAt), 'MMM d, yyyy')}
                          {transaction.expiresAt && (
                            <> • Expires {format(new Date(transaction.expiresAt), 'MMM d, yyyy')}</>
                          )}
                        </p>
                      </div>
                      <Badge 
                        variant={transaction.type === 'earned' ? 'default' : 'destructive'}
                        className={transaction.type === 'earned' ? 'bg-green-100 text-green-800' : ''}
                      >
                        {transaction.amount > 0 ? '+' : ''}{transaction.amount} credit{Math.abs(transaction.amount) !== 1 ? 's' : ''}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Coins className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No credit history yet</p>
                  <p className="text-sm">Start referring friends to earn credits!</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}