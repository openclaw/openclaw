import { Link } from "wouter";
import { ArrowLeft, Shield, Eye, Cookie, Mail, Database, Globe } from "lucide-react";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-brand-black via-neutral-900 to-brand-black">
      {/* Header */}
      <header className="bg-brand-black border-b border-neutral-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <Link href="/" className="inline-flex items-center gap-2 text-brand-green hover:text-brand-green-dark transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to CUTMV
          </Link>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-neutral-800 rounded-lg border border-neutral-700 p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Privacy Policy</h1>
            <p className="text-neutral-400">How we collect, use, and protect your information</p>
            <p className="text-sm text-neutral-500 mt-2">Last updated: July 26, 2025</p>
          </div>

          <div className="prose prose-invert max-w-none">
            {/* Information We Collect */}
            <section className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Database className="w-5 h-5 text-brand-green" />
                <h2 className="text-xl font-semibold text-white m-0">Information We Collect</h2>
              </div>
              
              <div className="space-y-4 text-neutral-300">
                <div>
                  <h3 className="text-lg font-medium text-white mb-2">Information You Provide</h3>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    <li>Email addresses when you subscribe to updates or make purchases</li>
                    <li>Payment information processed securely through Stripe</li>
                    <li>Video files you upload for processing (temporarily stored)</li>
                    <li>Feedback and support communications</li>
                  </ul>
                </div>

                <div>
                  <h3 className="text-lg font-medium text-white mb-2">Information We Collect Automatically</h3>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    <li>Usage analytics via PostHog (with your consent)</li>
                    <li>Device information and browser type</li>
                    <li>IP addresses and general location data</li>
                    <li>Email engagement metrics via Resend</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* How We Use Information */}
            <section className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Shield className="w-5 h-5 text-brand-green" />
                <h2 className="text-xl font-semibold text-white m-0">How We Use Your Information</h2>
              </div>
              
              <div className="space-y-3 text-neutral-300 text-sm">
                <div className="flex items-start gap-2">
                  <div className="w-2 h-2 bg-brand-green rounded-full mt-2 flex-shrink-0"></div>
                  <span><strong>Service Delivery:</strong> Process your videos and deliver generated content</span>
                </div>
                <div className="flex items-start gap-2">
                  <div className="w-2 h-2 bg-brand-green rounded-full mt-2 flex-shrink-0"></div>
                  <span><strong>Communication:</strong> Send download links, updates, and customer support</span>
                </div>
                <div className="flex items-start gap-2">
                  <div className="w-2 h-2 bg-brand-green rounded-full mt-2 flex-shrink-0"></div>
                  <span><strong>Improvement:</strong> Analyze usage patterns to enhance our platform</span>
                </div>
                <div className="flex items-start gap-2">
                  <div className="w-2 h-2 bg-brand-green rounded-full mt-2 flex-shrink-0"></div>
                  <span><strong>Marketing:</strong> Send promotional emails (with opt-out options)</span>
                </div>
              </div>
            </section>

            {/* Cookies and Tracking */}
            <section className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Cookie className="w-5 h-5 text-brand-green" />
                <h2 className="text-xl font-semibold text-white m-0">Cookies and Tracking</h2>
              </div>
              
              <div className="mb-4 text-neutral-300 text-sm">
                <p className="mb-3">We use cookies to enhance your experience and improve our services. You can control cookie preferences through our consent banner or by adjusting your browser settings.</p>
                
                <div className="bg-amber-900/20 border border-amber-600/30 rounded-lg p-3 mb-4">
                  <p className="text-amber-200 text-xs">
                    <strong>Cookie Consent:</strong> Our floating consent popup appears on your first visit. We respect your choices and only load tracking scripts after you accept optional cookies.
                  </p>
                </div>
              </div>
              
              <div className="space-y-4 text-neutral-300 text-sm">
                <div className="bg-neutral-700 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-4 h-4 text-green-500" />
                    <span className="font-medium text-white">Essential Cookies</span>
                  </div>
                  <p className="mb-2">Required for basic site functionality and security. These cannot be disabled.</p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-neutral-400">
                    <li><code>cutmv-cookie-consent</code> - Stores your cookie preferences</li>
                    <li><code>cutmv-cookie-timestamp</code> - Records when consent was given</li>
                    <li>Session cookies for secure payment processing via Stripe</li>
                  </ul>
                </div>

                <div className="bg-neutral-700 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Eye className="w-4 h-4 text-blue-500" />
                    <span className="font-medium text-white">Analytics Cookies</span>
                  </div>
                  <p className="mb-2">Help us understand how you use our site via PostHog analytics. <strong>Requires your consent.</strong></p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-neutral-400">
                    <li>PostHog session tracking and user behavior analytics</li>
                    <li>Performance monitoring and error tracking</li>
                    <li>Feature usage statistics to improve our platform</li>
                    <li>Anonymized usage patterns and conversion tracking</li>
                  </ul>
                </div>

                <div className="bg-neutral-700 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Mail className="w-4 h-4 text-purple-500" />
                    <span className="font-medium text-white">Marketing Cookies</span>
                  </div>
                  <p className="mb-2">Track email engagement and enable personalized marketing via Resend. <strong>Requires your consent.</strong></p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-neutral-400">
                    <li>Email open rates and click-through tracking</li>
                    <li>Automated email campaign triggers and sequences</li>
                    <li>User engagement scoring and segmentation</li>
                    <li>Personalized content recommendations</li>
                  </ul>
                </div>

                <div className="bg-neutral-700 rounded-lg p-4 border border-brand-green/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Cookie className="w-4 h-4 text-brand-green" />
                    <span className="font-medium text-white">Managing Your Cookie Preferences</span>
                  </div>
                  <div className="space-y-2 text-xs">
                    <p>You can change your cookie preferences at any time:</p>
                    <ul className="list-disc list-inside space-y-1 text-neutral-400">
                      <li><strong>Clear Browser Data:</strong> Delete cookies from your browser settings</li>
                      <li><strong>Disable in Browser:</strong> Block cookies entirely through browser preferences</li>
                      <li><strong>Contact Us:</strong> Email support@fulldigitalll.com to request data deletion</li>
                    </ul>
                    <p className="mt-2 text-neutral-400">
                      <strong>Note:</strong> Disabling essential cookies may limit site functionality.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Data Sharing */}
            <section className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Globe className="w-5 h-5 text-brand-green" />
                <h2 className="text-xl font-semibold text-white m-0">Data Sharing</h2>
              </div>
              
              <div className="space-y-3 text-neutral-300 text-sm">
                <p>We work with trusted service providers to deliver our service:</p>
                <ul className="list-disc list-inside space-y-1 ml-4">
                  <li><strong>Stripe:</strong> Payment processing (PCI DSS compliant)</li>
                  <li><strong>Cloudflare:</strong> File storage and delivery (R2)</li>
                  <li><strong>PostHog:</strong> Analytics and user behavior (with consent)</li>
                  <li><strong>Resend:</strong> Professional email delivery</li>
                </ul>
                <p className="font-medium text-white">We never sell your personal information to third parties.</p>
              </div>
            </section>

            {/* Data Retention */}
            <section className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Database className="w-5 h-5 text-brand-green" />
                <h2 className="text-xl font-semibold text-white m-0">Data Retention</h2>
              </div>
              
              <div className="space-y-2 text-neutral-300 text-sm">
                <div><strong>Video Files:</strong> Automatically deleted after 7 days</div>
                <div><strong>Generated Content:</strong> Available for download for 24 hours</div>
                <div><strong>Email Addresses:</strong> Retained until you unsubscribe</div>
                <div><strong>Analytics Data:</strong> Anonymized and retained for service improvement</div>
              </div>
            </section>

            {/* Your Rights */}
            <section className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Shield className="w-5 h-5 text-brand-green" />
                <h2 className="text-xl font-semibold text-white m-0">Your Rights</h2>
              </div>
              
              <div className="space-y-2 text-neutral-300 text-sm">
                <div>• <strong>Access:</strong> Request a copy of your personal data</div>
                <div>• <strong>Correction:</strong> Update or correct your information</div>
                <div>• <strong>Deletion:</strong> Request deletion of your data</div>
                <div>• <strong>Consent:</strong> Withdraw consent for cookies and marketing</div>
                <div>• <strong>Portability:</strong> Export your data in a common format</div>
              </div>
              
              <div className="mt-4 p-4 bg-neutral-700 rounded-lg">
                <p className="text-sm text-neutral-300">
                  To exercise these rights, contact us at{' '}
                  <a href="mailto:privacy@fulldigitalll.com" className="text-brand-green hover:text-brand-green-dark underline">
                    privacy@fulldigitalll.com
                  </a>
                </p>
              </div>
            </section>

            {/* Contact */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Mail className="w-5 h-5 text-brand-green" />
                <h2 className="text-xl font-semibold text-white m-0">Contact Us</h2>
              </div>
              
              <div className="text-neutral-300 text-sm space-y-2">
                <p>If you have questions about this Privacy Policy:</p>
                <div className="bg-neutral-700 rounded-lg p-4">
                  <div><strong>Email:</strong> privacy@fulldigitalll.com</div>
                  <div><strong>Support:</strong> staff@fulldigitalll.com</div>
                  <div><strong>Company:</strong> Full Digital LLC</div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}