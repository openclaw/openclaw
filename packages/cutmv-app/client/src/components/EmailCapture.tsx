/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Email Capture Component for Resend Integration
 * Proprietary software - unauthorized use prohibited
 */

import { useState } from "react";
import { Mail, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface EmailCaptureProps {
  source?: string;
  placeholder?: string;
  buttonText?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export default function EmailCapture({ 
  source = 'landing_page',
  placeholder = "Enter your email for updates",
  buttonText = "Get Updates",
  className = "",
  size = 'md'
}: EmailCaptureProps) {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!email.trim()) {
      toast({
        title: "Email required",
        description: "Please enter your email address",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/email-capture', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          source
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.success) {
        setIsSuccess(true);
        setEmail("");
        
        toast({
          title: "Thanks for subscribing!",
          description: result.emailSent ? 
            "Welcome email sent! Check your inbox for confirmation." : 
            "We'll keep you updated on new features and improvements.",
        });

        // Track successful email capture
        try {
          await fetch('/api/track-engagement', {
            method: 'POST',
            body: JSON.stringify({
              email: email.trim(),
              eventName: 'email_capture_success',
              eventProperties: {
                source,
                page: window.location.pathname
              }
            }),
            headers: {
              'Content-Type': 'application/json',
            },
          });
        } catch (trackingError) {
          console.debug('Email capture tracking failed (non-critical):', trackingError);
        }
      } else {
        throw new Error(result.message || 'Failed to subscribe');
      }
    } catch (error) {
      console.error('Email capture error:', error);
      toast({
        title: "Subscription failed",
        description: "Please try again or contact support if the problem persists.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isSuccess) {
    return (
      <div className={`flex items-center justify-center gap-2 text-brand-green ${className}`}>
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
        <span className="font-medium">Thanks! You're subscribed to updates.</span>
      </div>
    );
  }

  const inputSizeClass = size === 'sm' ? 'h-8 text-sm' : size === 'lg' ? 'h-12 text-lg' : 'h-10';
  const buttonSizeClass = size === 'sm' ? 'h-8 px-3 text-sm' : size === 'lg' ? 'h-12 px-6 text-lg' : 'h-10 px-4';

  return (
    <form onSubmit={handleSubmit} className={`flex gap-2 max-w-md ${className}`}>
      <div className="flex-1">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={placeholder}
          disabled={isLoading}
          className={`${inputSizeClass} bg-white border-gray-300 focus:border-brand-green focus:ring-brand-green`}
          required
        />
      </div>
      <Button
        type="submit"
        disabled={isLoading}
        className={`${buttonSizeClass} bg-brand-green hover:bg-brand-green/90 text-brand-black font-medium`}
      >
        {isLoading ? (
          <div className="w-4 h-4 border-2 border-brand-black/30 border-t-brand-black rounded-full animate-spin" />
        ) : (
          <>
            <Mail className="w-4 h-4 mr-1" />
            {buttonText}
          </>
        )}
      </Button>
    </form>
  );
}