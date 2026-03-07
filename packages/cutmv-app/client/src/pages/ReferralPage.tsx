/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Referral Page
 * Complete referral system page with dashboard and sharing
 */

import { ReferralDashboard } from '@/components/referral/ReferralDashboard';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Gift, Users, Coins, TrendingUp } from 'lucide-react';
import { Link } from 'wouter';

export default function ReferralPage() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="max-w-6xl mx-auto px-4 py-8">
          <div className="animate-pulse">
            <div className="h-8 bg-gray-200 rounded w-1/3 mb-4"></div>
            <div className="h-4 bg-gray-200 rounded w-1/2 mb-8"></div>
            <div className="grid gap-4 md:grid-cols-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-32 bg-gray-200 rounded-lg"></div>
              ))}
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="max-w-4xl mx-auto px-4 py-16">
          <div className="text-center space-y-8">
            <div>
              <h1 className="text-4xl font-bold mb-4">CUTMV Referral Program</h1>
              <p className="text-xl text-muted-foreground">
                Earn credits by referring friends to CUTMV
              </p>
            </div>

            {/* How It Works */}
            <div className="grid gap-6 md:grid-cols-3 mt-12">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-blue-600" />
                    1. Share Your Link
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    Get your unique referral link and share it with friends who need video editing tools.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Gift className="w-5 h-5 text-green-600" />
                    2. They Sign Up
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    When someone signs up using your link, you both get rewards. They get a bonus, you get credits.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Coins className="w-5 h-5 text-yellow-600" />
                    3. Earn Credits
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    Use your credits for professional exports, premium features, and exclusive benefits.
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Rewards Structure */}
            <Card className="max-w-2xl mx-auto">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" />
                  Reward Structure
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between items-center p-3 border rounded-lg">
                  <span>Friend signs up</span>
                  <span className="font-medium text-green-600">+1 Credit</span>
                </div>
                <div className="flex justify-between items-center p-3 border rounded-lg">
                  <span>Friend completes first export</span>
                  <span className="font-medium text-green-600">+1 Bonus Credit</span>
                </div>
                <div className="flex justify-between items-center p-3 border rounded-lg">
                  <span>Every 5 successful referrals</span>
                  <span className="font-medium text-green-600">+1 Bonus Credit</span>
                </div>
              </CardContent>
            </Card>

            {/* Call to Action */}
            <div className="space-y-4">
              <p className="text-lg font-medium">Ready to start earning?</p>
              <Link href="/login">
                <Button size="lg" className="bg-black hover:bg-gray-800">
                  Sign In to Get Started
                </Button>
              </Link>
              <p className="text-sm text-muted-foreground">
                Don't have an account? Signing in will create one automatically.
              </p>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <ReferralDashboard />
      </main>
      <Footer />
    </div>
  );
}