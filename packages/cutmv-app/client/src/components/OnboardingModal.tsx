/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState } from "react";
import { X, Scissors, Music, BarChart3, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

interface OnboardingModalProps {
  isOpen: boolean;
  onComplete: (data: { name: string; marketingConsent: boolean }) => void;
  userEmail: string;
}

export default function OnboardingModal({ isOpen, onComplete, userEmail }: OnboardingModalProps) {
  const [name, setName] = useState("");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(true);
  const [activeTab, setActiveTab] = useState("getting-started");
  const [nameError, setNameError] = useState("");
  const { toast } = useToast();

  const handleContinue = () => {
    if (!name.trim()) {
      setNameError("please enter a name");
      toast({
        title: "Name Required",
        description: "Please enter your full name to continue.",
        variant: "destructive"
      });
      return;
    }

    // Clear error if name is valid
    setNameError("");

    if (!tosAccepted || !privacyAccepted) {
      toast({
        title: "Agreement Required",
        description: "Please accept both Terms of Service and Privacy Policy to continue.",
        variant: "destructive"
      });
      return;
    }

    onComplete({ name: name.trim(), marketingConsent });
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold text-center">
            Welcome to CUTMV!
          </DialogTitle>
          <p className="text-center text-muted-foreground mt-2">
            We're excited to help you create professional music video content with AI-powered precision.
          </p>
        </DialogHeader>

        <div className="space-y-6">
          {/* Name Input */}
          <div className="space-y-2">
            <Label htmlFor="name" className="text-base font-medium">
              Your Name
            </Label>
            <Input
              id="name"
              placeholder="Enter your full name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError("");
              }}
              className={`text-base ${nameError ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
            />
            {nameError && (
              <p className="text-sm text-red-600 mt-1">{nameError}</p>
            )}
          </div>

          {/* Tabs for Getting Started, Terms, Privacy */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="getting-started">Getting Started</TabsTrigger>
              <TabsTrigger value="terms">Terms of Service</TabsTrigger>
              <TabsTrigger value="privacy">Privacy Policy</TabsTrigger>
            </TabsList>

            <TabsContent value="getting-started" className="space-y-4 mt-6">
              <div className="bg-gradient-to-br from-green-50 to-blue-50 dark:from-green-950/20 dark:to-blue-950/20 p-6 rounded-lg">
                <div className="flex items-center gap-2 mb-4">
                  <Scissors className="h-6 w-6" style={{ color: 'hsl(85, 70%, 55%)' }} />
                  <h3 className="text-lg font-semibold">How CUTMV Works</h3>
                </div>
                <p className="text-muted-foreground mb-4">
                  CUTMV helps music artists and labels create professional video content with intelligent
                  cutting algorithms that understand music video timing and flow.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="bg-blue-100 dark:bg-blue-900/30 p-2 rounded-full">
                      <Scissors className="h-4 w-4" style={{ color: 'hsl(85, 70%, 55%)' }} />
                    </div>
                    <h4 className="font-semibold">1. Upload & Process</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Upload your music videos and let our AI analyze timing, beats, and visual flow
                    for optimal cutting points.
                  </p>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="bg-purple-100 dark:bg-purple-900/30 p-2 rounded-full">
                      <Music className="h-4 w-4" style={{ color: 'hsl(85, 70%, 55%)' }} />
                    </div>
                    <h4 className="font-semibold">2. Smart Timestamps</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Generate precise timestamps or use our AI suggestions to create clips that
                    perfectly match your content strategy.
                  </p>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="bg-green-100 dark:bg-green-900/30 p-2 rounded-full">
                      <BarChart3 className="h-4 w-4" style={{ color: 'hsl(85, 70%, 55%)' }} />
                    </div>
                    <h4 className="font-semibold">3. Multi-Format Export</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Export in multiple formats: 16:9 for YouTube, 9:16 for TikTok/Instagram,
                    plus GIFs and Spotify Canvas.
                  </p>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="bg-orange-100 dark:bg-orange-900/30 p-2 rounded-full">
                      <Rocket className="h-4 w-4" style={{ color: 'hsl(85, 70%, 55%)' }} />
                    </div>
                    <h4 className="font-semibold">4. Professional Quality</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    All exports are professional quality optimized for
                    maximum engagement on each platform.
                  </p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="terms" className="mt-6">
              <div className="max-h-[300px] overflow-y-auto p-4 border rounded-lg bg-muted/10">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <h4 className="font-semibold mb-3">Terms of Service</h4>
                  <p className="text-sm text-muted-foreground mb-3">
                    By using CUTMV, you agree to the following terms:
                  </p>
                  <ul className="text-sm text-muted-foreground space-y-2 list-disc pl-4">
                    <li>You must own or have rights to all uploaded video content</li>
                    <li>CUTMV is a paid service requiring valid payment for processing</li>
                    <li>All exports are for your commercial and personal use</li>
                    <li>We reserve the right to terminate accounts that violate these terms</li>
                    <li>No refunds for successfully processed video content</li>
                    <li>Service availability is subject to maintenance and updates</li>
                    <li>You are responsible for compliance with platform-specific content policies</li>
                  </ul>
                  <p className="text-sm text-muted-foreground mt-4">
                    For complete terms, visit: <a href="/terms" className="text-green-600 hover:underline" target="_blank">/terms</a>
                  </p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="privacy" className="mt-6">
              <div className="max-h-[300px] overflow-y-auto p-4 border rounded-lg bg-muted/10">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <h4 className="font-semibold mb-3">Privacy Policy</h4>
                  <p className="text-sm text-muted-foreground mb-3">
                    Your privacy is important to us. Here's how we handle your data:
                  </p>
                  <ul className="text-sm text-muted-foreground space-y-2 list-disc pl-4">
                    <li>Videos are processed securely and deleted after 7 days</li>
                    <li>We only collect email and name for account management</li>
                    <li>Payment information is processed securely through Stripe</li>
                    <li>Analytics data is anonymized and used to improve service</li>
                    <li>We never share your content or personal data with third parties</li>
                    <li>You can request data deletion at any time</li>
                    <li>All data transmission uses industry-standard encryption</li>
                  </ul>
                  <p className="text-sm text-muted-foreground mt-4">
                    For complete privacy policy, visit: <a href="/privacy" className="text-green-600 hover:underline" target="_blank">/privacy</a>
                  </p>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {/* Agreement Notice */}
          <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
            <p className="text-sm text-amber-800 dark:text-amber-200 text-center">
              To continue, please review and accept our Terms of Service and Privacy Policy in the tabs above.
            </p>
          </div>

          {/* Checkboxes */}
          <div className="space-y-4">
            <div className="flex items-start space-x-3">
              <Checkbox
                id="tos"
                checked={tosAccepted}
                onCheckedChange={(checked) => setTosAccepted(checked === true)}
              />
              <Label htmlFor="tos" className="text-sm leading-relaxed">
                I have read and accept the{" "}
                <button
                  onClick={() => setActiveTab("terms")}
                  className="hover:underline font-medium"
                  style={{ color: 'hsl(85, 70%, 55%)' }}
                >
                  Terms of Service
                </button>
              </Label>
            </div>

            <div className="flex items-start space-x-3">
              <Checkbox
                id="privacy"
                checked={privacyAccepted}
                onCheckedChange={(checked) => setPrivacyAccepted(checked === true)}
              />
              <Label htmlFor="privacy" className="text-sm leading-relaxed">
                I have read and accept the{" "}
                <button
                  onClick={() => setActiveTab("privacy")}
                  className="hover:underline font-medium"
                  style={{ color: 'hsl(85, 70%, 55%)' }}
                >
                  Privacy Policy
                </button>
              </Label>
            </div>

            <div className="flex items-start space-x-3">
              <Checkbox
                id="marketing"
                checked={marketingConsent}
                onCheckedChange={(checked) => setMarketingConsent(checked === true)}
              />
              <Label htmlFor="marketing" className="text-sm leading-relaxed">
                I agree to receive marketing emails and communications about CUTMV updates,
                new features, and music industry insights (optional)
              </Label>
            </div>
          </div>

          {/* Continue Button */}
          <div className="flex justify-center pt-4">
            <Button
              onClick={handleContinue}
              size="lg"
              className="w-full sm:w-auto text-white px-8"
              style={{ backgroundColor: 'hsl(85, 70%, 55%)', borderColor: 'hsl(85, 70%, 55%)' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'hsl(85, 80%, 45%)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'hsl(85, 70%, 55%)'}
              disabled={!name.trim() || !tosAccepted || !privacyAccepted}
            >
              Continue to CUTMV
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}