/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState, useEffect } from "react";
import { CheckCircle, Loader2, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface PaymentSuccessProps {
  sessionId: string;
  onPaymentVerified: (paymentSession: any) => void;
  onError: () => void;
}

export default function PaymentSuccess({ sessionId, onPaymentVerified, onError }: PaymentSuccessProps) {
  const [isVerifying, setIsVerifying] = useState(true);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [paymentSession, setPaymentSession] = useState<any>(null);
  const { toast } = useToast();

  useEffect(() => {
    const verifyPayment = async () => {
      try {
        setIsVerifying(true);
        const response = await apiRequest("GET", `/api/verify-session/${sessionId}`);
        const data = await response.json();
        
        if (data.paid) {
          // Show success toast
          toast({
            title: "Payment Successful! 🎉",
            description: "Thanks! Your files will be ready soon.",
            duration: 4000,
          });
          
          setPaymentSession(data.session);
          onPaymentVerified(data.session);
          
          // Redirect to thank you page with user details
          const params = new URLSearchParams();
          if (data.session.userEmail) params.append('email', data.session.userEmail);
          if (data.session.videoName) params.append('video', data.session.videoName);
          
          setTimeout(() => {
            window.location.href = `/thank-you?${params.toString()}`;
          }, 2000); // Delay to show success toast
        } else {
          setVerificationError("Payment not yet completed. Please wait a moment and try again.");
        }
      } catch (error) {
        console.error('Payment verification error:', error);
        setVerificationError("Failed to verify payment. Please try again.");
      } finally {
        setIsVerifying(false);
      }
    };

    if (sessionId) {
      verifyPayment();
    }
  }, [sessionId, onPaymentVerified, toast]);

  const handleRetry = () => {
    setVerificationError(null);
    setIsVerifying(true);
    // Re-trigger verification
    const verifyPayment = async () => {
      try {
        const response = await apiRequest("GET", `/api/verify-session/${sessionId}`);
        const data = await response.json();
        
        if (data.paid) {
          setPaymentSession(data.session);
          onPaymentVerified(data.session);
        } else {
          setVerificationError("Payment not yet completed. Please wait a moment and try again.");
        }
      } catch (error) {
        setVerificationError("Failed to verify payment. Please try again.");
      } finally {
        setIsVerifying(false);
      }
    };
    verifyPayment();
  };

  if (isVerifying) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-brand-green" />
            Verifying Payment...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">
            Please wait while we verify your payment. This should only take a moment.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (verificationError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-yellow-600" />
            Payment Verification Issue
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription>{verificationError}</AlertDescription>
          </Alert>
          <div className="flex gap-2">
            <Button onClick={handleRetry} variant="default">
              Retry Verification
            </Button>
            <Button onClick={onError} variant="outline">
              Start Over
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (paymentSession) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-600" />
            Payment Successful!
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <p className="text-green-600 font-medium">
              Your payment has been processed successfully. You can now upload your video and begin processing.
            </p>
            
            <div className="bg-green-50 p-3 rounded-lg">
              <h4 className="font-medium text-green-800 mb-2">Your Purchase Includes:</h4>
              <ul className="text-sm text-green-700 space-y-1">
                {paymentSession.timestampCount > 0 && (
                  <li>• {paymentSession.timestampCount} video cutdowns in {paymentSession.aspectRatios.join(' & ')} format(s)</li>
                )}
                {paymentSession.generateGif && <li>• 10 GIF exports (6-second clips)</li>}
                {paymentSession.generateThumbnails && <li>• 10 high-quality thumbnail images</li>}
                {paymentSession.generateCanvas && <li>• 5 Spotify Canvas loops (vertical format)</li>}
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}