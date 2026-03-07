/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Subscription Page
 * Choose and manage subscription plans
 */

import { useState, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  ArrowLeft,
  Check,
  Sparkles,
  Zap,
  Crown,
  CreditCard,
  Archive,
  Loader2
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { AuthGuard } from '@/components/AuthGuard';
import FaviconProvider from '@/components/FaviconProvider';

interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  monthlyCredits: number;
  features: string[];
  popular?: boolean;
  icon: React.ReactNode;
  hasBulkDownload: boolean;
}

interface SubscriptionStatus {
  hasActiveSubscription: boolean;
  subscriptionId?: string;
  status?: string;
  currentPeriodEnd?: string;
  plan?: SubscriptionPlan;
  cancelAtPeriodEnd?: boolean;
}

const PLANS: SubscriptionPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: 10,
    monthlyCredits: 1000,
    icon: <Zap className="w-6 h-6" />,
    hasBulkDownload: false,
    features: [
      '1,000 credits/month',
      '50% off all processing',
      'All export formats',
      'Priority support',
      'Credits roll over (unused)',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 25,
    monthlyCredits: 3000,
    icon: <Sparkles className="w-6 h-6" />,
    popular: true,
    hasBulkDownload: true,
    features: [
      '3,000 credits/month',
      '50% off all processing',
      'All export formats',
      'Priority support',
      'Bulk ZIP downloads',
      'Credits roll over (unused)',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 75,
    monthlyCredits: 10000,
    icon: <Crown className="w-6 h-6" />,
    hasBulkDownload: true,
    features: [
      '10,000 credits/month',
      '50% off all processing',
      'All export formats',
      'Priority support',
      'Bulk ZIP downloads',
      'Dedicated account manager',
      'Credits roll over (unused)',
    ],
  },
];

export default function SubscriptionPage() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [currentSubscription, setCurrentSubscription] = useState<SubscriptionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  // Check URL for success/cancel status
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      toast({
        title: "Subscription Activated!",
        description: "Welcome! Your subscription is now active and credits have been added to your account.",
      });
      // Clear the URL params
      window.history.replaceState({}, '', '/app/subscription');
    } else if (params.get('canceled') === 'true') {
      toast({
        title: "Subscription Canceled",
        description: "You can subscribe anytime to get 50% off all processing.",
        variant: "destructive",
      });
      window.history.replaceState({}, '', '/app/subscription');
    }
  }, [toast]);

  useEffect(() => {
    fetchSubscriptionStatus();
  }, []);

  const fetchSubscriptionStatus = async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/subscription/status', {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setCurrentSubscription(data);
      } else {
        setCurrentSubscription({ hasActiveSubscription: false });
      }
    } catch (err) {
      console.error('Error fetching subscription status:', err);
      setCurrentSubscription({ hasActiveSubscription: false });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubscribe = async (planId: string) => {
    try {
      setSubscribing(planId);
      setError(null);

      const response = await fetch('/api/subscription/create-checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ planId }),
      });

      const data = await response.json();

      if (response.ok && data.checkoutUrl) {
        // Redirect to Stripe Checkout
        window.location.href = data.checkoutUrl;
      } else {
        throw new Error(data.error || 'Failed to create checkout session');
      }
    } catch (err) {
      console.error('Subscribe error:', err);
      setError(err instanceof Error ? err.message : 'Failed to start subscription');
      toast({
        title: "Subscription Error",
        description: err instanceof Error ? err.message : 'Failed to start subscription',
        variant: "destructive",
      });
    } finally {
      setSubscribing(null);
    }
  };

  const handleCancelSubscription = async () => {
    if (!confirm('Are you sure you want to cancel your subscription? You will keep access until the end of your billing period.')) {
      return;
    }

    try {
      setIsLoading(true);
      const response = await fetch('/api/subscription/cancel', {
        method: 'POST',
        credentials: 'include',
      });

      if (response.ok) {
        toast({
          title: "Subscription Canceled",
          description: "Your subscription will end at the end of your current billing period.",
        });
        fetchSubscriptionStatus();
      } else {
        const data = await response.json();
        throw new Error(data.error || 'Failed to cancel subscription');
      }
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : 'Failed to cancel subscription',
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleReactivate = async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/subscription/reactivate', {
        method: 'POST',
        credentials: 'include',
      });

      if (response.ok) {
        toast({
          title: "Subscription Reactivated",
          description: "Your subscription has been reactivated.",
        });
        fetchSubscriptionStatus();
      } else {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reactivate subscription');
      }
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : 'Failed to reactivate subscription',
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const isCurrentPlan = (planId: string) => {
    return currentSubscription?.hasActiveSubscription && currentSubscription?.plan?.id === planId;
  };

  if (isLoading) {
    return (
      <AuthGuard>
        <FaviconProvider
          title="Subscription - CUTMV | Full Digital"
          description="Choose your CUTMV subscription plan"
        >
          <div className="min-h-screen bg-gray-50 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-brand-green" />
          </div>
        </FaviconProvider>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <FaviconProvider
        title="Subscription - CUTMV | Full Digital"
        description="Choose your CUTMV subscription plan and save 50% on all video processing"
      >
        <div className="min-h-screen bg-gray-50">
          {/* Header */}
          <div className="bg-black text-white px-6 py-4">
            <div className="max-w-6xl mx-auto flex items-center gap-4">
              <Link href="/app/dashboard">
                <Button variant="ghost" size="sm" className="text-white hover:bg-gray-800">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Dashboard
                </Button>
              </Link>
              <div>
                <h1 className="text-xl font-bold">Subscription Plans</h1>
                <p className="text-gray-300 text-sm">Save 50% on all video processing</p>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="max-w-6xl mx-auto p-6">
            {/* Current Subscription Status */}
            {currentSubscription?.hasActiveSubscription && (
              <Alert className="mb-6 bg-brand-green/10 border-brand-green">
                <Sparkles className="w-4 h-4 text-brand-green" />
                <AlertDescription className="text-gray-900">
                  <div className="flex items-center justify-between">
                    <div>
                      <strong>Current Plan:</strong> {currentSubscription.plan?.name} - ${currentSubscription.plan?.price}/month
                      {currentSubscription.cancelAtPeriodEnd && (
                        <span className="text-orange-600 ml-2">(Cancels at period end)</span>
                      )}
                      {currentSubscription.currentPeriodEnd && (
                        <span className="text-gray-600 ml-2">
                          | Renews: {new Date(currentSubscription.currentPeriodEnd).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {currentSubscription.cancelAtPeriodEnd ? (
                        <Button
                          size="sm"
                          onClick={handleReactivate}
                          className="bg-brand-green hover:bg-brand-green/90 text-black"
                        >
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleCancelSubscription}
                        >
                          Cancel Subscription
                        </Button>
                      )}
                    </div>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="destructive" className="mb-6">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Value Proposition */}
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                Subscribe & Save 50%
              </h2>
              <p className="text-gray-600 max-w-2xl mx-auto">
                Subscribers pay half the credit cost for all video processing.
                Your payment method is securely stored for automatic monthly renewal.
              </p>
            </div>

            {/* Pricing Cards */}
            <div className="grid md:grid-cols-3 gap-6 mb-8">
              {PLANS.map((plan) => (
                <Card
                  key={plan.id}
                  className={`relative ${
                    plan.popular
                      ? 'border-brand-green border-2 shadow-lg'
                      : 'border-gray-200'
                  } ${isCurrentPlan(plan.id) ? 'ring-2 ring-brand-green' : ''}`}
                >
                  {plan.popular && (
                    <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-green text-black">
                      Most Popular
                    </Badge>
                  )}
                  {isCurrentPlan(plan.id) && (
                    <Badge className="absolute -top-3 right-4 bg-blue-600 text-white">
                      Current Plan
                    </Badge>
                  )}

                  <CardHeader className="text-center pb-2">
                    <div className={`w-12 h-12 mx-auto rounded-full flex items-center justify-center mb-2 ${
                      plan.popular ? 'bg-brand-green/20 text-brand-green' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {plan.icon}
                    </div>
                    <CardTitle className="text-xl">{plan.name}</CardTitle>
                    <div className="mt-2">
                      <span className="text-4xl font-bold">${plan.price}</span>
                      <span className="text-gray-500">/month</span>
                    </div>
                    <CardDescription className="mt-1">
                      {plan.monthlyCredits.toLocaleString()} credits/month
                    </CardDescription>
                  </CardHeader>

                  <CardContent>
                    <ul className="space-y-3 mb-6">
                      {plan.features.map((feature, index) => (
                        <li key={index} className="flex items-start gap-2">
                          <Check className="w-5 h-5 text-brand-green flex-shrink-0 mt-0.5" />
                          <span className="text-sm text-gray-700">{feature}</span>
                        </li>
                      ))}
                    </ul>

                    {isCurrentPlan(plan.id) ? (
                      <Button
                        className="w-full"
                        variant="outline"
                        disabled
                      >
                        Current Plan
                      </Button>
                    ) : currentSubscription?.hasActiveSubscription ? (
                      <Button
                        className="w-full"
                        variant="outline"
                        onClick={() => handleSubscribe(plan.id)}
                        disabled={subscribing === plan.id}
                      >
                        {subscribing === plan.id ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Processing...
                          </>
                        ) : (
                          <>Switch to {plan.name}</>
                        )}
                      </Button>
                    ) : (
                      <Button
                        className={`w-full ${
                          plan.popular
                            ? 'bg-brand-green hover:bg-brand-green/90 text-black'
                            : ''
                        }`}
                        variant={plan.popular ? 'default' : 'outline'}
                        onClick={() => handleSubscribe(plan.id)}
                        disabled={subscribing === plan.id}
                      >
                        {subscribing === plan.id ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Processing...
                          </>
                        ) : (
                          <>
                            <CreditCard className="w-4 h-4 mr-2" />
                            Subscribe to {plan.name}
                          </>
                        )}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Credit Pricing Info */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="text-lg">Credit Pricing (with subscription)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <p className="font-semibold text-gray-900">Cutdown Video</p>
                    <p className="text-2xl font-bold text-brand-green">50</p>
                    <p className="text-xs text-gray-500">credits each</p>
                    <p className="text-xs text-gray-400 line-through">100 without sub</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <p className="font-semibold text-gray-900">GIF Pack</p>
                    <p className="text-2xl font-bold text-brand-green">90</p>
                    <p className="text-xs text-gray-500">10 GIFs</p>
                    <p className="text-xs text-gray-400 line-through">180 without sub</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <p className="font-semibold text-gray-900">Thumbnail Pack</p>
                    <p className="text-2xl font-bold text-brand-green">90</p>
                    <p className="text-xs text-gray-500">10 thumbnails</p>
                    <p className="text-xs text-gray-400 line-through">180 without sub</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <p className="font-semibold text-gray-900">Spotify Canvas</p>
                    <p className="text-2xl font-bold text-brand-green">225</p>
                    <p className="text-xs text-gray-500">5 loops</p>
                    <p className="text-xs text-gray-400 line-through">450 without sub</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* FAQ / Info */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
              <h3 className="font-semibold text-blue-900 mb-4">Subscription FAQ</h3>
              <div className="space-y-3 text-sm text-blue-800">
                <div>
                  <strong>How does billing work?</strong>
                  <p>Your card is charged monthly. We securely store your payment info via Stripe for automatic renewal.</p>
                </div>
                <div>
                  <strong>What if my payment fails?</strong>
                  <p>We'll email you reminders for 5 days to update your payment method before pausing your subscription.</p>
                </div>
                <div>
                  <strong>Can I cancel anytime?</strong>
                  <p>Yes! Cancel anytime and keep access until your billing period ends. No questions asked.</p>
                </div>
                <div>
                  <strong>Do unused credits roll over?</strong>
                  <p>Subscription credits reset each month, but purchased credits never expire.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </FaviconProvider>
    </AuthGuard>
  );
}
