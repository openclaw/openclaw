/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import fdLogo from "@/assets/fd-logo.png";

export default function Terms() {
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
              <img src={fdLogo} alt="Full Digital" className="h-8 w-8" />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Card className="bg-white dark:bg-gray-900">
          <CardHeader>
            <CardTitle className="text-3xl font-bold text-center">Terms of Service</CardTitle>
            <p className="text-center text-gray-600 dark:text-gray-400">
              Effective Date: January 18, 2025
            </p>
          </CardHeader>
          <CardContent className="prose prose-gray dark:prose-invert max-w-none">
            <p className="lead">
              Welcome to CUTMV ("we," "us," or "our"). By using our service, you agree to be bound by the following terms:
            </p>

            <h2>1. ACCEPTANCE OF TERMS</h2>
            <p>
              By accessing or using CUTMV, you confirm that you are at least 18 years old and agree to comply with these Terms of Service. If you do not agree, you may not use our tool.
            </p>

            <h2>2. SERVICE DESCRIPTION</h2>
            <p>
              CUTMV is a video cutdown and formatting tool designed specifically for music videos. Features include:
            </p>
            <ul>
              <li>Timestamp-based clip generation with fade effects</li>
              <li>Dual aspect ratio formatting (16:9 and 9:16)</li>
              <li>Automatic letterbox detection and removal</li>
              <li>Motion tracking for vertical content</li>
              <li>Spotify Canvas loop generation</li>
              <li>GIF and thumbnail export capabilities</li>
              <li>Professional video processing with FFmpeg</li>
            </ul>

            <h2>3. LICENSE & INTELLECTUAL PROPERTY</h2>
            <p>
              All underlying software, processes, algorithms, and enhancements are the exclusive intellectual property of Full Digital LLC. You are granted a limited, non-exclusive, non-transferable license to use the tool for its intended purpose. The following actions are strictly prohibited:
            </p>
            <ul>
              <li>Reverse engineering or decompiling any part of the software</li>
              <li>Reselling, redistributing, or sublicensing the tool</li>
              <li>Modifying, copying, or creating derivative works</li>
              <li>Attempting to extract proprietary algorithms or code</li>
              <li>Using the tool to compete with Full Digital LLC services</li>
            </ul>

            <h2>4. USER CONTENT AND COPYRIGHT</h2>
            <p>
              Users are solely responsible for ensuring they have the legal right to upload, edit, and distribute any video content used in CUTMV. Full Digital LLC is not liable for:
            </p>
            <ul>
              <li>Copyright infringement by users</li>
              <li>Unauthorized use of copyrighted material</li>
              <li>Any legal disputes arising from user content</li>
              <li>Third-party claims related to user uploads</li>
            </ul>

            <h2>5. PAYMENT AND BILLING</h2>
            <p>
              CUTMV operates on a usage-based pricing model. No subscription is required. Users are charged for:
            </p>
            <ul>
              <li>Video processing and export generation</li>
              <li>Premium features like Canvas loops and dual aspect ratios</li>
              <li>Large file processing (files over certain size thresholds)</li>
            </ul>
            <p>
              All payments are processed securely through trusted third-party payment providers. We do not store payment information.
            </p>

            <h2>6. SERVICE LIMITATIONS AND DISCLAIMERS</h2>
            <p>
              CUTMV is provided "as is" without warranties of any kind. We do not guarantee:
            </p>
            <ul>
              <li>Uninterrupted service availability</li>
              <li>Error-free processing of all video formats</li>
              <li>Specific processing speeds or output quality</li>
              <li>Compatibility with all video codecs or formats</li>
            </ul>

            <h2>7. DATA SECURITY AND FILE HANDLING</h2>
            <p>
              For your security and privacy:
            </p>
            <ul>
              <li>Uploaded videos are automatically deleted after 24 hours</li>
              <li>Generated clips and exports are temporarily stored for download</li>
              <li>We implement industry-standard security measures</li>
              <li>Files are processed in secure, isolated environments</li>
            </ul>

            <h2>8. PROHIBITED USES</h2>
            <p>
              Users may not use CUTMV for:
            </p>
            <ul>
              <li>Processing illegal, harmful, or offensive content</li>
              <li>Uploading malware, viruses, or malicious files</li>
              <li>Attempting to overload or disrupt our systems</li>
              <li>Violating any applicable laws or regulations</li>
              <li>Infringing on third-party intellectual property rights</li>
            </ul>

            <h2>9. TERMINATION</h2>
            <p>
              We reserve the right to suspend or terminate any account or usage that:
            </p>
            <ul>
              <li>Violates these terms of service</li>
              <li>Interferes with system integrity or other users</li>
              <li>Engages in fraudulent or abusive behavior</li>
              <li>Attempts unauthorized access to our systems</li>
            </ul>

            <h2>10. LIMITATION OF LIABILITY</h2>
            <p>
              Full Digital LLC's liability is limited to the amount paid for services. We are not liable for:
            </p>
            <ul>
              <li>Indirect, consequential, or punitive damages</li>
              <li>Loss of profits, data, or business opportunities</li>
              <li>Damages resulting from user content or third-party actions</li>
              <li>Service interruptions or technical issues</li>
            </ul>

            <h2>11. MODIFICATIONS TO TERMS</h2>
            <p>
              We reserve the right to update these Terms of Service at any time. Material changes will be communicated through:
            </p>
            <ul>
              <li>Email notification (if you have provided an email address)</li>
              <li>Prominent notice on our website</li>
              <li>In-app notifications when you next use the service</li>
            </ul>
            <p>
              Continued use of CUTMV after changes constitutes acceptance of the new terms.
            </p>

            <h2>12. GOVERNING LAW AND DISPUTES</h2>
            <p>
              These terms are governed by the laws of the jurisdiction where Full Digital LLC is incorporated. Any disputes will be resolved through binding arbitration.
            </p>

            <h2>13. CONTACT INFORMATION</h2>
            <p>
              For questions about these Terms of Service, contact us at:
            </p>
            <ul>
              <li>Website: <a href="https://www.fulldigitalll.com" target="_blank" rel="noopener noreferrer" className="text-brand-green hover:text-brand-green-light">fulldigitalll.com</a></li>
              <li>Email: legal@fulldigitalll.com</li>
            </ul>

            <div className="mt-8 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                By clicking "I Agree" or using CUTMV, you acknowledge that you have read, understood, and agree to be bound by these Terms of Service.
              </p>
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
                <a href="/privacy" className="text-brand-green hover:text-brand-green-light underline">
                  Privacy Policy
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