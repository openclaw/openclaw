/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Add Payment Method Page
 * Stripe payment method setup using Setup Intents
 */

import { useState, useEffect } from 'react';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, CreditCard, CheckCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { AuthGuard } from '@/components/AuthGuard';
import FaviconProvider from '@/components/FaviconProvider';
import { Link, useLocation } from 'wouter';

// Load Stripe (only if key is provided)
const stripePromise = import.meta.env.VITE_STRIPE_PUBLIC_KEY
  ? loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY)
  : null;

interface SetupFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

function SetupForm({ onSuccess, onCancel }: SetupFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { error } = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: window.location.origin + '/app/profile?tab=billing&success=true',
        },
      });

      if (error) {
        setError(error.message || 'An error occurred while setting up your payment method.');
        toast({
          title: "Setup Failed",
          description: error.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Payment Method Added",
          description: "Your payment method has been saved successfully.",
        });
        onSuccess();
      }
    } catch (err) {
      setError('An unexpected error occurred. Please try again.');
      toast({
        title: "Error",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <PaymentElement 
          options={{
            layout: 'tabs',
          }}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-3 pt-4">
        <Button
          type="submit"
          disabled={!stripe || isLoading}
          className="flex-1 bg-brand-green hover:bg-brand-green/90 text-black"
        >
          {isLoading ? (
            <>
              <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin mr-2" />
              Adding Payment Method...
            </>
          ) : (
            <>
              <CreditCard className="w-4 h-4 mr-2" />
              Add Payment Method
            </>
          )}
        </Button>
        
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isLoading}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function AddPaymentMethodPage() {
  const [, setLocation] = useLocation();
  const [clientSecret, setClientSecret] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [success, setSuccess] = useState(false);
  const { toast } = useToast();

  // Check if Stripe is configured
  if (!stripePromise) {
    return (
      <AuthGuard>
        <FaviconProvider
          title="Add Payment Method - CUTMV | Full Digital"
          description="Add a payment method to your CUTMV account for faster checkout when processing videos."
        >
          <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
            <Card className="w-full max-w-md">
              <CardContent className="pt-6 text-center">
                <p className="text-gray-600 mb-4">Payment processing is not currently configured.</p>
                <Button onClick={() => setLocation('/app/profile')}>
                  Return to Profile
                </Button>
              </CardContent>
            </Card>
          </div>
        </FaviconProvider>
      </AuthGuard>
    );
  }

  useEffect(() => {
    createSetupIntent();
  }, []);

  const createSetupIntent = async () => {
    try {
      setIsLoading(true);
      const response = await apiRequest('POST', '/api/billing/setup-intent');
      const data = await response.json();
      
      if (data.clientSecret) {
        setClientSecret(data.clientSecret);
      } else {
        throw new Error('No client secret received');
      }
    } catch (error) {
      console.error('Error creating setup intent:', error);
      toast({
        title: "Error",
        description: "Failed to initialize payment setup. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSuccess = () => {
    setSuccess(true);
    setTimeout(() => {
      setLocation('/app/profile?tab=billing');
    }, 2000);
  };

  const handleCancel = () => {
    setLocation('/app/profile?tab=billing');
  };

  if (success) {
    return (
      <AuthGuard>
        <FaviconProvider 
          title="Payment Method Added - CUTMV | Full Digital"
          description="Successfully added payment method to your CUTMV account for faster checkout."
        >
          <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
            <Card className="w-full max-w-md">
              <CardContent className="pt-6 text-center">
                <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">Payment Method Added!</h2>
                <p className="text-gray-600 mb-4">
                  Your payment method has been saved successfully. Redirecting to your profile...
                </p>
                <div className="w-8 h-8 border-2 border-brand-green border-t-transparent rounded-full animate-spin mx-auto" />
              </CardContent>
            </Card>
          </div>
        </FaviconProvider>
      </AuthGuard>
    );
  }

  if (isLoading) {
    return (
      <AuthGuard>
        <FaviconProvider 
          title="Add Payment Method - CUTMV | Full Digital"
          description="Add a payment method to your CUTMV account for faster checkout when processing videos."
        >
          <div className="min-h-screen bg-gray-50 flex items-center justify-center">
            <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-brand-green"></div>
          </div>
        </FaviconProvider>
      </AuthGuard>
    );
  }

  if (!clientSecret) {
    return (
      <AuthGuard>
        <FaviconProvider 
          title="Add Payment Method - CUTMV | Full Digital"
          description="Add a payment method to your CUTMV account for faster checkout when processing videos."
        >
          <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
            <Card className="w-full max-w-md">
              <CardContent className="pt-6 text-center">
                <p className="text-red-600 mb-4">Failed to initialize payment setup.</p>
                <Button onClick={() => setLocation('/app/profile?tab=billing')}>
                  Return to Profile
                </Button>
              </CardContent>
            </Card>
          </div>
        </FaviconProvider>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <FaviconProvider 
        title="Add Payment Method - CUTMV | Full Digital"
        description="Add a payment method to your CUTMV account for faster checkout when processing videos."
      >
        <div className="min-h-screen bg-gray-50">
          {/* Header */}
          <div className="bg-black text-white px-6 py-4">
            <div className="max-w-2xl mx-auto flex items-center gap-4">
              <Link href="/app/profile?tab=billing">
                <Button variant="ghost" size="sm" className="text-white hover:bg-gray-800">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Profile
                </Button>
              </Link>
              <div>
                <h1 className="text-xl font-bold">Add Payment Method</h1>
                <p className="text-gray-300 text-sm">Securely store your payment information</p>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="max-w-2xl mx-auto p-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CreditCard className="w-5 h-5" />
                  Payment Information
                </CardTitle>
                <CardDescription>
                  Add a payment method for faster checkout when processing videos. 
                  Your payment information is securely stored by Stripe and never saved on our servers.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Elements
                  stripe={stripePromise}
                  options={{
                    clientSecret,
                    appearance: {
                      theme: 'stripe',
                      variables: {
                        colorPrimary: 'hsl(85, 70%, 55%)',
                      },
                    },
                  }}
                >
                  <SetupForm onSuccess={handleSuccess} onCancel={handleCancel} />
                </Elements>
              </CardContent>
            </Card>

            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h4 className="font-medium text-blue-900 mb-2">Secure Payment Processing</h4>
              <ul className="text-sm text-blue-800 space-y-1">
                <li>• Your payment information is encrypted and stored securely by Stripe</li>
                <li>• We never store your credit card details on our servers</li>
                <li>• You can update or remove your payment method anytime</li>
                <li>• Adding a payment method enables faster checkout for video processing</li>
              </ul>
            </div>
          </div>
        </div>
      </FaviconProvider>
    </AuthGuard>
  );
}