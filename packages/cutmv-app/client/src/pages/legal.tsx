/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Legal Documents Page
 * Terms of Service and Privacy Policy
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileText, Shield, Scale } from 'lucide-react';
import FaviconProvider from '@/components/FaviconProvider';
import DashboardLayout from '@/components/DashboardLayout';
import { useAuth, AuthGuard } from '@/components/AuthGuard';

export default function LegalPage() {
  const { user, isLoading } = useAuth();

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

  return (
    <AuthGuard>
      <FaviconProvider 
        title="Legal & Privacy - CUTMV | Full Digital"
        description="Read CUTMV's Terms of Service and Privacy Policy. Understand our data practices and user agreement for our AI-powered video platform."
      >
        <DashboardLayout currentUser={user} onLogout={handleLogout}>
        <div className="p-6">
          {/* Page Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Legal & Privacy</h1>
                <p className="text-gray-600">Terms of Service and Privacy Policy</p>
              </div>

            </div>
          </div>

          <Tabs defaultValue="terms" className="space-y-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="terms" className="flex items-center gap-2">
                <Scale className="w-4 h-4" />
                Terms of Service
              </TabsTrigger>
              <TabsTrigger value="privacy" className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Privacy Policy
              </TabsTrigger>
            </TabsList>

            <TabsContent value="terms">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Scale className="w-5 h-5" />
                    Terms of Service
                  </CardTitle>
                  <CardDescription>
                    Last updated: January 2025
                  </CardDescription>
                </CardHeader>
                <CardContent className="prose max-w-none">
                  <h3>1. Acceptance of Terms</h3>
                  <p>
                    By accessing and using CUTMV ("the Service"), you accept and agree to be bound by the terms and provision of this agreement.
                  </p>

                  <h3>2. Service Description</h3>
                  <p>
                    CUTMV is an AI-powered video creation platform that enables users to transform music videos into optimized content formats including video cutdowns, GIFs, thumbnails, and Spotify Canvas.
                  </p>

                  <h3>3. User Accounts</h3>
                  <p>
                    You are responsible for maintaining the confidentiality of your account information and for all activities that occur under your account. CUTMV uses magic link authentication for enhanced security.
                  </p>

                  <h3>4. Payment and Credits</h3>
                  <p>
                    CUTMV operates on a credit-based system. Video cutdowns cost $0.99, GIFs and thumbnails cost $1.99, and Spotify Canvas costs $4.99. All transactions are processed securely through Stripe.
                  </p>

                  <h3>5. Content and Intellectual Property</h3>
                  <p>
                    You retain ownership of content you upload to CUTMV. By using our service, you grant us a limited license to process your content for the purpose of providing our video creation services.
                  </p>

                  <h3>6. Referral Program</h3>
                  <p>
                    Our referral program provides $1 credit for each successful referral. Referral abuse or fraud may result in account suspension and forfeiture of credits.
                  </p>

                  <h3>7. Service Availability</h3>
                  <p>
                    We strive to maintain 99.9% uptime but cannot guarantee uninterrupted service. Exported files are available for download for 7 days unless pinned.
                  </p>

                  <h3>8. Prohibited Uses</h3>
                  <p>
                    You may not use CUTMV for any illegal purposes, to upload copyrighted content without permission, or to circumvent our payment systems.
                  </p>

                  <h3>9. Limitation of Liability</h3>
                  <p>
                    CUTMV shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of the service.
                  </p>

                  <h3>10. Changes to Terms</h3>
                  <p>
                    We reserve the right to modify these terms at any time. Continued use of the service constitutes acceptance of modified terms.
                  </p>

                  <h3>Contact Information</h3>
                  <p>
                    For questions about these Terms of Service, please contact us at legal@fulldigitalll.com
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="privacy">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Shield className="w-5 h-5" />
                    Privacy Policy
                  </CardTitle>
                  <CardDescription>
                    Last updated: January 2025
                  </CardDescription>
                </CardHeader>
                <CardContent className="prose max-w-none">
                  <h3>1. Information We Collect</h3>
                  <p>
                    We collect information you provide directly to us, such as your email address for account creation and any content you upload for processing.
                  </p>

                  <h3>2. How We Use Your Information</h3>
                  <p>
                    We use your information to provide our video processing services, communicate with you about your account, and improve our platform through analytics.
                  </p>

                  <h3>3. Information Sharing</h3>
                  <p>
                    We do not sell, trade, or otherwise transfer your personal information to third parties except as described in this policy or with your consent.
                  </p>

                  <h3>4. Data Storage and Security</h3>
                  <p>
                    Your uploaded videos are stored securely using Cloudflare R2 with automatic cleanup after 7 days. We implement industry-standard security measures to protect your data.
                  </p>

                  <h3>5. Authentication</h3>
                  <p>
                    We use magic link authentication instead of passwords for enhanced security. Login links are sent to your verified email address.
                  </p>

                  <h3>6. Analytics and Tracking</h3>
                  <p>
                    We use PostHog for product analytics and Sentry for error tracking to improve our service. These tools help us understand how our platform is used.
                  </p>

                  <h3>7. Email Communications</h3>
                  <p>
                    We may send you service-related emails and, with your consent, marketing communications about new features and promotions.
                  </p>

                  <h3>8. Your Rights</h3>
                  <p>
                    You have the right to access, update, or delete your personal information. You can manage your preferences or delete your account through your profile settings.
                  </p>

                  <h3>9. Children's Privacy</h3>
                  <p>
                    Our service is not intended for children under 13. We do not knowingly collect personal information from children under 13.
                  </p>

                  <h3>10. Changes to Privacy Policy</h3>
                  <p>
                    We may update this privacy policy from time to time. We will notify you of any changes by posting the new privacy policy on this page.
                  </p>

                  <h3>Contact Information</h3>
                  <p>
                    For questions about this Privacy Policy, please contact us at privacy@fulldigitalll.com
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </DashboardLayout>
    </FaviconProvider>
    </AuthGuard>
  );
}